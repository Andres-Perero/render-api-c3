/**
 * api-server.js
 *
 * GET  /health
 * GET  /api/catalog/series
 * GET  /api/catalog/movies
 * POST /api/catalog/series/refresh
 * POST /api/catalog/movies/refresh
 * GET  /api/series/:slug
 * GET  /api/series/:slug/:seasonParam
 * GET  /api/movies/:slug
 */
import express from 'express';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG, log } from './shared/config.js';
import { getJsonFromDrive } from './shared/drive-client.js';
import { ensureDir } from './shared/state-manager.js';
import { scrapeOneSeries, scrapeOneSeason } from './cuevana_bio/series/scrape-one.js';
import { scrapeOneMovie } from './cuevana_bio/peliculas/scrape-one.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// CORS — permite front en cualquier origen (file://, localhost, Vercel, etc.)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const DRIVE_FOLDER_SERIES =
  process.env.DRIVE_FOLDER_SERIES ||
  process.env.DRIVE_FOLDER_CUEVANA_BIO ||
  process.env.DRIVE_FOLDER_CUEVANA3 ||
  '';
const DRIVE_FOLDER_PELICULAS =
  process.env.DRIVE_FOLDER_PELICULAS ||
  process.env.DRIVE_FOLDER_CUEVANA3 ||
  DRIVE_FOLDER_SERIES ||
  '';

const SERIES_JSON_LOCAL = join(CONFIG.SERIES_DATA_DIR, 'series.json');
const PELICULAS_JSON_LOCAL = join(CONFIG.PELICULAS_DATA_DIR, 'peliculas.json');
const USER_DATA_DIR = join(CONFIG.ROOT_DIR, '.browser-profile');

const CATALOG_TTL_MS = 15 * 60 * 1000;
const caches = {
  series: { data: null, loadedAt: 0 },
  movies: { data: null, loadedAt: 0 }
};

async function loadCatalog(type) {
  const cache = caches[type];
  const now = Date.now();
  if (cache.data && now - cache.loadedAt < CATALOG_TTL_MS) return cache.data;

  const driveFolder = type === 'series' ? DRIVE_FOLDER_SERIES : DRIVE_FOLDER_PELICULAS;
  const fileName = type === 'series' ? 'series.json' : 'peliculas.json';
  const localPath = type === 'series' ? SERIES_JSON_LOCAL : PELICULAS_JSON_LOCAL;

  if (driveFolder) {
    try {
      log(`Cargando ${fileName} desde Drive...`);
      const json = await getJsonFromDrive(driveFolder, fileName);
      if (json) {
        const list = json.movies || json.series || json.items || [];
        cache.data = list;
        cache.loadedAt = now;
        log(`Catálogo ${type} Drive: ${list.length}`);
        return list;
      }
    } catch (e) {
      log(`Drive ${type} falló: ${e.message}`);
    }
  }

  if (existsSync(localPath)) {
    const json = JSON.parse(readFileSync(localPath, 'utf8'));
    const list = json.movies || json.series || json.items || [];
    cache.data = list;
    cache.loadedAt = now;
    log(`Catálogo ${type} local: ${list.length}`);
    return list;
  }

  cache.data = [];
  cache.loadedAt = now;
  return [];
}

function findInCatalog(list, slug) {
  return list.find((s) => s.slug === slug || s.id === slug) || null;
}

function buildSeriesFromSlug(slug) {
  const base = (CONFIG.BASE_URL || 'https://cuevana3i.bio').replace(/\/+$/, '');
  return {
    id: slug,
    slug,
    titulo: slug,
    url_directa: `${base}/serie/${slug}`,
    plataforma: 'Cuevana3',
    type: 'series'
  };
}

function buildMovieFromSlug(slug) {
  const base = (CONFIG.BASE_URL || 'https://cuevana3i.bio').replace(/\/+$/, '');
  return {
    id: slug,
    slug,
    titulo: slug,
    url_directa: `${base}/pelicula/${slug}`,
    plataforma: 'Cuevana3',
    type: 'movie'
  };
}

function parseSeasonParam(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(?:temp(?:orada)?[-_]?)?(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Health ──────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, platform: CONFIG.PLATFORM, ts: new Date().toISOString() });
});

// ─── Catalogs ────────────────────────────────────────────────
app.get('/api/catalog/series', async (_req, res) => {
  try {
    const list = await loadCatalog('series');
    res.json({
      total: list.length,
      source: DRIVE_FOLDER_SERIES ? 'drive' : 'local',
      series: list
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/movies', async (_req, res) => {
  try {
    const list = await loadCatalog('movies');
    res.json({
      total: list.length,
      source: DRIVE_FOLDER_PELICULAS ? 'drive' : 'local',
      movies: list
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// alias legacy
app.get('/api/catalog', async (_req, res) => {
  try {
    const list = await loadCatalog('series');
    res.json({ total: list.length, source: DRIVE_FOLDER_SERIES ? 'drive' : 'local', series: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/catalog/series/refresh', async (_req, res) => {
  caches.series = { data: null, loadedAt: 0 };
  try {
    const list = await loadCatalog('series');
    res.json({ ok: true, total: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/catalog/movies/refresh', async (_req, res) => {
  caches.movies = { data: null, loadedAt: 0 };
  try {
    const list = await loadCatalog('movies');
    res.json({ ok: true, total: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Series ──────────────────────────────────────────────────
app.get('/api/series/:slug', async (req, res) => {
  const slug = (req.params.slug || '').trim().replace(/\/+$/, '');
  if (!slug) return res.status(400).json({ error: 'slug requerido' });

  log(`API serie: ${slug}`);
  try {
    const catalog = await loadCatalog('series');
    const series = findInCatalog(catalog, slug) || buildSeriesFromSlug(slug);
    ensureDir(USER_DATA_DIR);

    const details = await scrapeOneSeries(series, {
      resolveServers: req.query.resolve !== '0',
      maxSeasons: parseInt(req.query.maxSeasons || '0', 10) || 0,
      maxEpisodes: parseInt(req.query.maxEpisodes || '0', 10) || 0,
      includeEpisodes: req.query.full === '1',
      userDataDir: USER_DATA_DIR
    });
    res.json(details);
  } catch (err) {
    log(`ERROR /api/series/${slug}: ${err.message}`);
    res.status(500).json({
      slug,
      error: err.message || 'Error desconocido',
      status: 'error',
      scrapedAt: new Date().toISOString()
    });
  }
});

app.get('/api/series/:slug/:seasonParam', async (req, res) => {
  const slug = (req.params.slug || '').trim().replace(/\/+$/, '');
  const seasonNum = parseSeasonParam(req.params.seasonParam);

  if (!slug) return res.status(400).json({ error: 'slug requerido' });
  if (!seasonNum || seasonNum < 1) {
    return res.status(400).json({
      error: 'temporada inválida',
      hint: 'usa /api/series/futurama/temp1'
    });
  }

  log(`API temporada: ${slug} T${seasonNum}`);
  try {
    const catalog = await loadCatalog('series');
    const series = findInCatalog(catalog, slug) || buildSeriesFromSlug(slug);
    ensureDir(USER_DATA_DIR);

    const details = await scrapeOneSeason(series, seasonNum, {
      resolveServers: req.query.resolve !== '0',
      maxEpisodes: parseInt(req.query.maxEpisodes || '0', 10) || 0,
      userDataDir: USER_DATA_DIR
    });
    res.json(details);
  } catch (err) {
    log(`ERROR /api/series/${slug}/temp${seasonNum}: ${err.message}`);
    res.status(500).json({
      slug,
      temporada: seasonNum,
      error: err.message || 'Error desconocido',
      status: 'error',
      scrapedAt: new Date().toISOString()
    });
  }
});

// ─── Movies ──────────────────────────────────────────────────
/**
 * GET /api/movies/:slug
 * Meta + servidores resueltos (como un solo episodio).
 */
app.get('/api/movies/:slug', async (req, res) => {
  const slug = (req.params.slug || '').trim().replace(/\/+$/, '');
  if (!slug) return res.status(400).json({ error: 'slug requerido' });

  log(`API película: ${slug}`);
  try {
    const catalog = await loadCatalog('movies');
    const movie = findInCatalog(catalog, slug) || buildMovieFromSlug(slug);
    ensureDir(USER_DATA_DIR);

    const details = await scrapeOneMovie(movie, {
      resolveServers: req.query.resolve !== '0',
      userDataDir: USER_DATA_DIR
    });
    res.json(details);
  } catch (err) {
    log(`ERROR /api/movies/${slug}: ${err.message}`);
    res.status(500).json({
      slug,
      error: err.message || 'Error desconocido',
      status: 'error',
      scrapedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  log(`API listening on :${PORT}`);
  log(`PLATFORM=${CONFIG.PLATFORM} BASE_URL=${CONFIG.BASE_URL}`);
  log(`DRIVE series=${DRIVE_FOLDER_SERIES || '(none)'} peliculas=${DRIVE_FOLDER_PELICULAS || '(none)'}`);
});
