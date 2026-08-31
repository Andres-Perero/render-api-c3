/**
 * series/scrape-detalles.js
 * Serie → temps (chunks) → episodios (chunks) → servidores → resolve
 * cuevana_bio / cuevana3l.biz
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CONFIG, log } from '../../shared/config.js';
import {
  loadDetailsState,
  saveDetailsState,
  saveDetailsOutput,
  ensureDir
} from '../../shared/state-manager.js';
import {
  parseCuevanaSerieDetalle,
  extractSerieDetalleFromDOM,
  extractEpisodesFromSeasonDOM,
  extractServersFromTabsDOM,
  parseEpisodeServers
} from './extractor-series-detail.js';

chromium.use(stealthPlugin());

const INPUT_FILE = join(CONFIG.SERIES_DATA_DIR, 'series.json');
const OUTPUT_FILE = join(CONFIG.SERIES_DATA_DIR, 'details-series.json');
const STATE_FILE = join(CONFIG.SERIES_DATA_DIR, 'details-series-state.json');
const USER_DATA_DIR = join(CONFIG.ROOT_DIR, '.browser-profile');

const ONLY_SLUG = (() => {
  let s = (process.env.ONLY_SLUG || '').trim();
  if (!s) return null;
  return s.replace(/\/+$/, '').replace(/^.*\//, '') || null;
})();
const FORCE_ALL = process.env.FORCE_ALL === '1';
const RETRY_ERRORS = process.env.RETRY_ERRORS === '1';
const START_INDEX = parseInt(process.env.START_INDEX || '0', 10);
const END_INDEX = process.env.END_INDEX ? parseInt(process.env.END_INDEX, 10) : Infinity;
const MAX_SEASONS = parseInt(process.env.MAX_SEASONS || '0', 10);
const MAX_EPISODES = parseInt(process.env.MAX_EPISODES_PER_SEASON || '0', 10);
const CONCURRENCY = Math.max(1, Math.min(CONFIG.CONCURRENCY || 2, 4));
const RETRIES = Math.max(1, CONFIG.RETRIES || 2);
const RESOLVE_SERVERS = process.env.RESOLVE_SERVERS !== '0';
// Chunks internos (por serie)
const SEASON_CONCURRENCY = Math.max(1, parseInt(process.env.SEASON_CONCURRENCY || '2', 10));
const EPISODE_CONCURRENCY = Math.max(1, parseInt(process.env.EPISODE_CONCURRENCY || '5', 10));

function loadCatalog() {
  if (!existsSync(INPUT_FILE)) {
    throw new Error(`No existe ${INPUT_FILE}. Ejecuta primero scrape-catalogo.js`);
  }
  const data = JSON.parse(readFileSync(INPUT_FILE, 'utf8'));
  const list = data.movies || data.series || data.items || [];
  if (!Array.isArray(list)) throw new Error(`${INPUT_FILE} no contiene lista válida.`);
  const unique = [];
  const seen = new Set();
  for (const item of list) {
    if (item.slug && !seen.has(item.slug)) {
      seen.add(item.slug);
      unique.push(item);
    }
  }
  return unique;
}

function shouldProcess(series, state) {
  if (ONLY_SLUG) return series.slug === ONLY_SLUG || series.id === ONLY_SLUG;
  if (FORCE_ALL) return true;
  if (RETRY_ERRORS) return state.errorSlugs.has(series.slug);
  return !state.processedSlugs.has(series.slug);
}

function absUrl(href, origin) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  return `${origin}${href.startsWith('/') ? '' : '/'}${href}`;
}

function needsResolve(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.includes('/player.php')) return true;
  if (/tungtungsahur\./i.test(url)) return true;
  if (/[?&](token|v)=/i.test(url) && /cuevana/i.test(url)) return true;
  return false;
}

async function handleCloudflare(page) {
  const blocked = await page.evaluate(() =>
    /just a moment|attention required|cloudflare/i.test(document.title)
  );
  if (!blocked) return;
  log('  ⚠️ CF — resuelve captcha (90s)...');
  await page.waitForFunction(
    () => !/just a moment|attention required/i.test(document.title),
    { timeout: 90_000 }
  );
  log('  ✅ CF OK');
}

async function gotoSafe(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 50_000 });
  await handleCloudflare(page);
  await page.waitForTimeout(400);
}

/** Pool simple de concurrencia */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── RESOLVER ─────────────────────────────────────────────────

function tryDecodeBase64(url) {
  try {
    const vMatch = url.match(/[?&]v=([A-Za-z0-9+/=]+)/);
    if (!vMatch) return null;
    const decoded = Buffer.from(vMatch[1], 'base64').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch { /* */ }
  return null;
}

async function resolveSingleServer(page, servidor) {
  const original = servidor.url;
  if (!needsResolve(original)) {
    return { ...servidor, resolved: true };
  }

  const decoded = tryDecodeBase64(original);
  if (decoded) {
    return {
      ...servidor,
      url: decoded,
      url_original: original,
      resolved: true,
      resolvedVia: 'base64'
    };
  }

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      await page.goto(original, { waitUntil: 'domcontentloaded', timeout: 18_000 });
      await page.waitForFunction(() => {
        const iframe = document.querySelector('iframe');
        const src = iframe ? (iframe.getAttribute('src') || iframe.src || '') : '';
        if (src && src !== 'about:blank' && !/tungtungsahur/i.test(src)) return true;
        if (document.querySelector('video source, video[src]')) return true;
        return false;
      }, { timeout: 8_000 }).catch(() => {});

      const found = await page.evaluate(() => {
        for (const iframe of document.querySelectorAll('iframe')) {
          const src = iframe.getAttribute('src') || iframe.src || '';
          if (src && src !== 'about:blank' && !/tungtungsahur/i.test(src)) {
            return { type: 'iframe', src };
          }
        }
        const source = document.querySelector('video source[src], video[src]');
        if (source) {
          const src = source.getAttribute('src') || source.src || '';
          if (src) return { type: 'video', src };
        }
        if (!/tungtungsahur/i.test(location.href) && /embed|player|stream/i.test(location.href)) {
          return { type: 'location', src: location.href };
        }
        for (const iframe of document.querySelectorAll('iframe')) {
          const src = iframe.getAttribute('src') || iframe.src || '';
          if (src && src !== 'about:blank') return { type: 'iframe-fallback', src };
        }
        return null;
      }).catch(() => null);

      if (found?.src) {
        const finalUrl = found.src.startsWith('//') ? `https:${found.src}` : found.src;
        return {
          ...servidor,
          url: finalUrl,
          url_original: original,
          resolved: true,
          resolvedVia: found.type
        };
      }
    } catch (e) {
      if (attempt === RETRIES) {
        return { ...servidor, url_original: original, resolved: false, resolveError: e.message };
      }
    }
    if (attempt < RETRIES) await page.waitForTimeout(500 * attempt);
  }
  return { ...servidor, url_original: original, resolved: false };
}

async function resolveServidores(page, servidores) {
  if (!RESOLVE_SERVERS || !servidores?.length) return servidores;

  // 1) base64 al instante (sin navegación)
  const out = servidores.map((srv) => {
    if (!needsResolve(srv.url)) return { ...srv, resolved: true };
    const decoded = tryDecodeBase64(srv.url);
    if (decoded) {
      return {
        ...srv,
        url: decoded,
        url_original: srv.url,
        resolved: true,
        resolvedVia: 'base64'
      };
    }
    return null; // pendiente de navegar
  });

  // 2) los que quedan (token) — secuencial en esta page
  for (let i = 0; i < servidores.length; i++) {
    if (out[i] !== null) continue;
    out[i] = await resolveSingleServer(page, servidores[i]);
  }
  return out;
}

// ─── SCRAPE helpers ───────────────────────────────────────────

async function scrapeSerieMeta(page, series) {
  const url = series.url_directa || `${CONFIG.BASE_URL}/serie/${series.slug}`;
  await gotoSafe(page, url);

  try {
    await page.waitForSelector('.objects-item a, .subtitle, h1', { timeout: 12_000 });
  } catch { /* */ }

  let detalle = await page.evaluate((fnStr) => {
    const fn = new Function('return (' + fnStr + ')')();
    return fn();
  }, extractSerieDetalleFromDOM.toString()).catch(() => null);

  if (!detalle || !detalle.temporadas?.length) {
    detalle = parseCuevanaSerieDetalle(await page.content());
  }

  const origin = await page.evaluate(() => location.origin);
  for (const t of detalle.temporadas || []) {
    t.url = absUrl(t.url, origin);
  }

  let anio = detalle.anio || detalle.estreno || null;
  if (anio && !/^\d{4}$/.test(String(anio))) {
    anio = String(anio).match(/\d{4}/)?.[0] || null;
  }

  let generos = detalle.generos || [];
  if (!Array.isArray(generos)) generos = generos ? [generos] : [];
  generos = generos.flat().map((g) => String(g).trim()).filter(Boolean);

  return {
    slug: series.slug,
    url_directa: series.url_directa || page.url(),
    titulo: detalle.titulo || series.titulo || series.slug,
    imagen: detalle.imagen || series.imagen || null,
    anio,
    total_temporadas: detalle.total_temporadas || detalle.temporadas?.length || 0,
    resumen: detalle.resumen || null,
    generos,
    temporadasMeta: detalle.temporadas || [],
    origin
  };
}

async function scrapeSeasonEpisodes(page, seasonUrl, seasonNum) {
  await gotoSafe(page, seasonUrl);
  try {
    await page.waitForSelector('a[href*="episodio-"]', { timeout: 12_000 });
  } catch { /* */ }
  await page.waitForTimeout(300);

  let episodes = await page.evaluate((fnStr) => {
    const fn = new Function('return (' + fnStr + ')')();
    return fn();
  }, extractEpisodesFromSeasonDOM.toString()).catch(() => []);

  const origin = await page.evaluate(() => location.origin);
  for (const ep of episodes) {
    ep.url_directa = absUrl(ep.url_directa, origin);
    if (ep.temporada == null) ep.temporada = seasonNum;
  }

  if (seasonNum != null) {
    const filtered = episodes.filter(
      (e) => e.temporada == null || Number(e.temporada) === Number(seasonNum)
    );
    if (filtered.length) episodes = filtered;
  }
  return episodes;
}

async function scrapeEpisodeServers(page, epUrl) {
  await gotoSafe(page, epUrl);
  try {
    await page.waitForSelector('ul.tabs-video, [data-server]', { timeout: 10_000 });
  } catch { /* */ }
  await page.waitForTimeout(250);

  let servidores = await page.evaluate((fnStr) => {
    const fn = new Function('return (' + fnStr + ')')();
    return fn();
  }, extractServersFromTabsDOM.toString()).catch(() => []);

  if (!servidores.length) {
    servidores = parseEpisodeServers(await page.content());
  }

  if (RESOLVE_SERVERS && servidores.length) {
    servidores = await resolveServidores(page, servidores);
  }
  return servidores;
}

/** Procesa un episodio completo (con reintentos) */
async function processEpisode(page, ep, seasonNum) {
  let servidores = [];
  let lastErr = null;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      servidores = await scrapeEpisodeServers(page, ep.url_directa);
      if (servidores.length || attempt === RETRIES) break;
      throw new Error('0 servidores');
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await page.waitForTimeout(500 * attempt);
    }
  }

  const nSrv = servidores.length;
  const nRes = servidores.filter((s) => s.resolved).length;

  return {
    detail: {
      slug: ep.slug,
      titulo: ep.titulo,
      url_directa: ep.url_directa,
      temporada: ep.temporada ?? seasonNum,
      episodio: ep.episodio ?? ep.numero,
      servidores,
      status: nSrv ? 'ok' : lastErr ? 'error' : 'no_servers',
      error: nSrv ? undefined : lastErr?.message,
      scrapedAt: new Date().toISOString()
    },
    nSrv,
    nRes
  };
}

/** Procesa una temporada: lista eps + chunks de episodios en paralelo */
async function processSeason(context, season, setupPage) {
  const seasonNum = season.numero ?? season.label;
  log(`  → T${seasonNum}: ${season.url}`);

  const page = await context.newPage();
  await setupPage(page);

  let episodes = [];
  try {
    try {
      episodes = await scrapeSeasonEpisodes(page, season.url, season.numero);
    } catch (e) {
      log(`    ERROR lista T${seasonNum}: ${e.message} — reintento`);
      episodes = await scrapeSeasonEpisodes(page, season.url, season.numero).catch(() => []);
    }

    if (MAX_EPISODES > 0) episodes = episodes.slice(0, MAX_EPISODES);
    log(`    T${seasonNum}: ${episodes.length} episodios → chunks x${EPISODE_CONCURRENCY}`);

    // Páginas extra para episodios en paralelo
    const epPages = [page];
    for (let i = 1; i < Math.min(EPISODE_CONCURRENCY, episodes.length); i++) {
      const p = await context.newPage();
      await setupPage(p);
      epPages.push(p);
    }

    let cursor = 0;
    const getEpPage = () => epPages[cursor++ % epPages.length];

    const results = await mapPool(episodes, EPISODE_CONCURRENCY, async (ep) => {
      const p = getEpPage();
      const r = await processEpisode(p, ep, season.numero);
      log(
        `      Ep ${ep.slug}: ${r.nSrv} srv${RESOLVE_SERVERS ? ` (${r.nRes} res)` : ''}`
      );
      return r;
    });

    // Cerrar páginas extra (dejar la primera para el caller? no, cerramos todas)
    for (const p of epPages) await p.close().catch(() => {});

    const epDetails = results.map((r) => r.detail);
    const nSrv = results.reduce((a, r) => a + r.nSrv, 0);
    const nRes = results.reduce((a, r) => a + r.nRes, 0);

    return {
      seasonData: {
        numero: season.numero,
        label: season.label || `Temporada ${season.numero}`,
        url: season.url,
        poster: season.poster || null,
        total_episodios: epDetails.length,
        episodios: epDetails
      },
      nSrv,
      nRes,
      nEps: epDetails.length
    };
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
}

async function processSeries(context, setupPage, series) {
  log(`▶ Serie: ${series.titulo || series.slug}`);

  const metaPage = await context.newPage();
  await setupPage(metaPage);

  let meta;
  try {
    meta = await scrapeSerieMeta(metaPage, series);
  } finally {
    await metaPage.close().catch(() => {});
  }

  let seasons = meta.temporadasMeta || [];
  if (MAX_SEASONS > 0) seasons = seasons.slice(0, MAX_SEASONS);

  log(
    `  Temporadas: ${seasons.length} | SEASON_CONC=${SEASON_CONCURRENCY} | EP_CONC=${EPISODE_CONCURRENCY} | Resolve=${RESOLVE_SERVERS ? 'ON' : 'OFF'}`
  );

  // Chunks de temporadas en paralelo
  const seasonResults = await mapPool(seasons, SEASON_CONCURRENCY, async (season) => {
    try {
      return await processSeason(context, season, setupPage);
    } catch (e) {
      log(`    ERROR T${season.numero}: ${e.message}`);
      return {
        seasonData: {
          numero: season.numero,
          label: season.label || `Temporada ${season.numero}`,
          url: season.url,
          poster: season.poster || null,
          total_episodios: 0,
          episodios: [],
          error: e.message
        },
        nSrv: 0,
        nRes: 0,
        nEps: 0
      };
    }
  });

  // Ordenar por número de temporada
  seasonResults.sort(
    (a, b) => (a.seasonData.numero || 0) - (b.seasonData.numero || 0)
  );

  const seasonsData = seasonResults.map((r) => r.seasonData);
  const totalEps = seasonResults.reduce((a, r) => a + r.nEps, 0);
  const totalSrv = seasonResults.reduce((a, r) => a + r.nSrv, 0);
  const totalSrvOk = seasonResults.reduce((a, r) => a + r.nRes, 0);

  return {
    slug: meta.slug,
    url_directa: meta.url_directa,
    titulo: meta.titulo,
    imagen: meta.imagen,
    anio: meta.anio,
    resumen: meta.resumen,
    categoria: 'serie',
    generos: meta.generos,
    total_temporadas: seasonsData.length,
    total_episodios: totalEps,
    temporadas: seasonsData,
    plataforma: 'Cuevana3',
    type: 'series',
    serversResolution: RESOLVE_SERVERS
      ? { total: totalSrv, resueltos: totalSrvOk, completo: totalSrv === 0 || totalSrvOk === totalSrv }
      : undefined,
    scrapedAt: new Date().toISOString(),
    status: 'ok'
  };
}

async function runWorkerPool(items, concurrency, workerFn) {
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      await workerFn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function main() {
  log('=== scrape-detalles series (chunks temp + eps) ===');
  log(`CONCURRENCY=${CONCURRENCY} SEASON=${SEASON_CONCURRENCY} EP=${EPISODE_CONCURRENCY}`);
  log(`RESOLVE_SERVERS=${RESOLVE_SERVERS ? '1' : '0'} RETRIES=${RETRIES}`);

  ensureDir(CONFIG.SERIES_DATA_DIR);
  ensureDir(USER_DATA_DIR);

  const seriesList = loadCatalog();
  let state = loadDetailsState(STATE_FILE);
  if (!state.detailsById) state.detailsById = {};
  if (!(state.processedSlugs instanceof Set)) {
    state.processedSlugs = new Set(state.processedSlugs || []);
  }
  if (!(state.errorSlugs instanceof Set)) {
    state.errorSlugs = new Set(state.errorSlugs || []);
  }

  const pending = seriesList
    .map((s, index) => ({ series: s, index }))
    .filter(
      ({ series, index }) =>
        index >= START_INDEX &&
        index < END_INDEX &&
        shouldProcess(series, state)
    );

  log(`Catálogo: ${seriesList.length} | Pendientes: ${pending.length}`);
  if (ONLY_SLUG) log(`ONLY_SLUG=${ONLY_SLUG}`);
  if (MAX_SEASONS) log(`MAX_SEASONS=${MAX_SEASONS}`);
  if (MAX_EPISODES) log(`MAX_EPISODES_PER_SEASON=${MAX_EPISODES}`);

  if (!pending.length) {
    log('Nada pendiente.');
    return;
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    viewport: { width: 1280, height: 720 },
    locale: 'es-ES'
  });

  async function setupPage(page) {
    await page.route(
      '**/*.{png,jpg,jpeg,webp,gif,svg,ttf,woff,woff2,mp4,mp3}',
      (r) => r.abort()
    ).catch(() => {});
  }

  // Limitar series concurrentes: si SEASON_CONC alto, bajar series concurrentes
  const seriesConc = Math.max(1, Math.min(CONCURRENCY, 2));

  let okCount = 0;
  let errCount = 0;
  let savedCount = 0;
  const t0 = Date.now();

  await runWorkerPool(pending, seriesConc, async ({ series, index }) => {
    let details = null;
    let lastError = null;

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        details = await processSeries(context, setupPage, series);
        break;
      } catch (err) {
        lastError = err;
        log(`[${index + 1}] Intento ${attempt} falló: ${err.message}`);
        if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }

    if (details) {
      state.detailsById[series.slug] = details;
      state.processedSlugs.add(series.slug);
      state.errorSlugs.delete(series.slug);
      okCount++;
      const res = details.serversResolution;
      log(
        `[${index + 1}/${seriesList.length}] OK: ${details.titulo} | ${details.total_temporadas}T ${details.total_episodios}E` +
          (res ? ` | srv ${res.resueltos}/${res.total}` : '')
      );
    } else {
      state.detailsById[series.slug] = {
        slug: series.slug,
        url_directa: series.url_directa,
        error: lastError?.message || 'Error desconocido',
        scrapedAt: new Date().toISOString(),
        status: 'error'
      };
      state.errorSlugs.add(series.slug);
      errCount++;
      log(`[${index + 1}/${seriesList.length}] ERROR: ${series.slug} — ${lastError?.message}`);
    }

    savedCount++;
    if (savedCount >= (CONFIG.SAVE_EVERY_N || 5)) {
      const toSave = {
        ...state,
        processedSlugs: [...state.processedSlugs],
        errorSlugs: [...state.errorSlugs]
      };
      saveDetailsState(STATE_FILE, toSave);
      saveDetailsOutput(OUTPUT_FILE, toSave, 'Cuevana3 - Series Details');
      savedCount = 0;
      log('>>> Guardado intermedio');
    }
  });

  const finalState = {
    ...state,
    processedSlugs: [...state.processedSlugs],
    errorSlugs: [...state.errorSlugs]
  };
  saveDetailsState(STATE_FILE, finalState);
  saveDetailsOutput(OUTPUT_FILE, finalState, 'Cuevana3 - Series Details');

  await context.close();

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  log('========================================');
  log(`OK: ${okCount} | Errores: ${errCount} | Tiempo: ${sec}s`);
  log(`Archivo: ${OUTPUT_FILE}`);
  log('========================================');
}

main().catch((e) => {
  console.error('Error fatal:', e);
  process.exit(1);
});
