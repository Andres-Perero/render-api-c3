/**
 * scrape-one.js
 * Scrapea UNA serie o UNA temporada y devuelve el objeto.
 */
import { join } from 'node:path';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CONFIG, log } from '../../shared/config.js';
import {
  parseCuevanaSerieDetalle,
  extractSerieDetalleFromDOM,
  extractEpisodesFromSeasonDOM,
  extractServersFromTabsDOM,
  parseEpisodeServers
} from './extractor-series-detail.js';

chromium.use(stealthPlugin());

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
  await page.waitForTimeout(500);
}

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

  try {
    await gotoSafe(page, original);
    const finalUrl = page.url();
    if (finalUrl && finalUrl !== original && !needsResolve(finalUrl)) {
      return {
        ...servidor,
        url: finalUrl,
        url_original: original,
        resolved: true,
        resolvedVia: 'navigate'
      };
    }
    const iframeSrc = await page.evaluate(() => {
      const ifr = document.querySelector('iframe[src]');
      return ifr ? ifr.getAttribute('src') : null;
    }).catch(() => null);
    if (iframeSrc && /^https?:\/\//i.test(iframeSrc)) {
      return {
        ...servidor,
        url: iframeSrc,
        url_original: original,
        resolved: true,
        resolvedVia: 'iframe'
      };
    }
  } catch (e) {
    return { ...servidor, resolved: false, resolveError: e.message };
  }
  return { ...servidor, resolved: false };
}

async function launchContext(userDataDir) {
  return chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage'
    ],
    viewport: { width: 1280, height: 720 },
    locale: 'es-ES'
  });
}

async function setupPage(page) {
  await page.route(
    '**/*.{png,jpg,jpeg,webp,gif,svg,ttf,woff,woff2,mp4,mp3}',
    (r) => r.abort()
  ).catch(() => {});
}

async function scrapeSerieMeta(page, series) {
  const url = series.url_directa;
  await gotoSafe(page, url);
  const origin = await page.evaluate(() => location.origin);

  let meta;
  try {
    meta = await page.evaluate((fnStr) => {
      const fn = new Function('return (' + fnStr + ')')();
      return fn(document);
    }, extractSerieDetalleFromDOM.toString());
  } catch {
    meta = null;
  }

  if (!meta || !meta.titulo) {
    const html = await page.content();
    meta = parseCuevanaSerieDetalle(html) || {};
  }

  const seasons = (meta.temporadas || meta.temporadasMeta || []).map((s) => ({
    numero: s.numero ?? s.number ?? 0,
    label: s.label || `Temporada ${s.numero ?? s.number ?? ''}`,
    url: absUrl(s.url || s.href, origin),
    poster: s.poster || null
  })).filter((s) => s.url);

  return {
    slug: series.slug,
    url_directa: url,
    titulo: meta.titulo || series.titulo || series.slug,
    imagen: meta.imagen || series.imagen || null,
    anio: meta.estreno || meta.anio || series.anio || null,
    resumen: meta.resumen || null,
    generos: meta.generos || [],
    temporadasMeta: seasons,
    origin
  };
}

async function processEpisode(page, ep, origin, resolveServers) {
  const epUrl = ep.url || ep.url_directa;
  await gotoSafe(page, epUrl);
  let servers = [];
  try {
    servers = await page.evaluate((fnStr) => {
      const fn = new Function('return (' + fnStr + ')')();
      return fn(document);
    }, extractServersFromTabsDOM.toString());
  } catch {
    const html = await page.content();
    servers = parseEpisodeServers(html) || [];
  }

  servers = (servers || []).map((s) => ({
    ...s,
    url: absUrl(s.url, origin)
  }));

  let resolved = servers;
  if (resolveServers && servers.length) {
    resolved = [];
    for (const srv of servers) {
      resolved.push(await resolveSingleServer(page, srv));
    }
  }

  return {
    detail: {
      slug: ep.slug,
      numero: ep.numero ?? ep.episodio,
      temporada: ep.temporada,
      titulo: ep.titulo || ep.slug,
      url: epUrl,
      poster: ep.poster || null,
      servidores: resolved
    },
    nSrv: servers.length,
    nRes: resolved.filter((s) => s.resolved !== false).length
  };
}

/**
 * Procesa una temporada: lista episodios + servidores resueltos.
 */
async function processSeason(context, season, opts) {
  const listPage = await context.newPage();
  await setupPage(listPage);

  try {
    await gotoSafe(listPage, season.url);
    const origin = await listPage.evaluate(() => location.origin);

    let episodes = [];
    try {
      episodes = await listPage.evaluate((fnStr) => {
        const fn = new Function('return (' + fnStr + ')')();
        return fn(document);
      }, extractEpisodesFromSeasonDOM.toString());
    } catch {
      episodes = [];
    }

    // extractor usa url_directa
    episodes = (episodes || []).map((e) => ({
      ...e,
      url: absUrl(e.url_directa || e.url || e.href, origin)
    })).filter((e) => e.url);

    log(`    Episodios encontrados: ${episodes.length}`);
    if (opts.maxEpisodes > 0) episodes = episodes.slice(0, opts.maxEpisodes);

    const epConcurrency = Math.max(1, opts.episodeConcurrency || 3);
    const epPages = [];
    for (let i = 0; i < Math.min(epConcurrency, Math.max(episodes.length, 1)); i++) {
      const p = await context.newPage();
      await setupPage(p);
      epPages.push(p);
    }

    let epIdx = 0;
    const results = await mapPool(episodes, epConcurrency, async (ep) => {
      const p = epPages[epIdx++ % epPages.length];
      try {
        const r = await processEpisode(p, ep, origin, opts.resolveServers);
        log(`      Ep ${ep.slug}: ${r.nSrv} srv (${r.nRes} res)`);
        return r;
      } catch (err) {
        log(`      Ep ${ep.slug} ERROR: ${err.message}`);
        return {
          detail: {
            slug: ep.slug,
            numero: ep.numero ?? ep.episodio,
            temporada: ep.temporada,
            titulo: ep.titulo || ep.slug,
            url: ep.url,
            servidores: [],
            error: err.message
          },
          nSrv: 0,
          nRes: 0
        };
      }
    });

    for (const p of epPages) await p.close().catch(() => {});

    const epDetails = results.map((r) => r.detail);
    return {
      seasonData: {
        numero: season.numero,
        label: season.label || `Temporada ${season.numero}`,
        url: season.url,
        poster: season.poster || null,
        total_episodios: epDetails.length,
        episodios: epDetails
      },
      nSrv: results.reduce((a, r) => a + r.nSrv, 0),
      nRes: results.reduce((a, r) => a + r.nRes, 0),
      nEps: epDetails.length
    };
  } finally {
    await listPage.close().catch(() => {});
  }
}

/**
 * Scrapea solo UNA temporada (episodios + servidores resueltos).
 * @param {object} series - { slug, url_directa, titulo? }
 * @param {number} seasonNum - número de temporada (1-based)
 * @param {object} options
 */
export async function scrapeOneSeason(series, seasonNum, options = {}) {
  const resolveServers = options.resolveServers !== false;
  const maxEpisodes = options.maxEpisodes || 0;
  const episodeConcurrency = Math.max(1, parseInt(process.env.EPISODE_CONCURRENCY || '3', 10));
  const userDataDir = options.userDataDir || join(CONFIG.ROOT_DIR, '.browser-profile');

  const context = await launchContext(userDataDir);

  try {
    log(`▶ Serie: ${series.titulo || series.slug} | Temporada ${seasonNum}`);

    const metaPage = await context.newPage();
    await setupPage(metaPage);
    let meta;
    try {
      meta = await scrapeSerieMeta(metaPage, series);
    } finally {
      await metaPage.close().catch(() => {});
    }

    const seasons = meta.temporadasMeta || [];
    let season = seasons.find((s) => Number(s.numero) === Number(seasonNum));

    // fallback: construir URL si no está en meta
    if (!season) {
      const base = (series.url_directa || meta.url_directa || '').replace(/\/+$/, '');
      season = {
        numero: seasonNum,
        label: `Temporada ${seasonNum}`,
        url: `${base}/temporada-${seasonNum}`,
        poster: null
      };
      log(`  Temporada no en meta → URL construida: ${season.url}`);
    }

    const result = await processSeason(context, season, {
      resolveServers,
      maxEpisodes,
      episodeConcurrency
    });

    return {
      slug: meta.slug || series.slug,
      titulo: meta.titulo || series.titulo || series.slug,
      imagen: meta.imagen || series.imagen || null,
      temporada: result.seasonData.numero,
      label: result.seasonData.label,
      url: result.seasonData.url,
      poster: result.seasonData.poster,
      total_episodios: result.nEps,
      episodios: result.seasonData.episodios,
      serversResolution: resolveServers
        ? {
            total: result.nSrv,
            resueltos: result.nRes,
            completo: result.nSrv === 0 || result.nRes === result.nSrv
          }
        : undefined,
      scrapedAt: new Date().toISOString(),
      status: 'ok'
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Scrapea una serie completa (solo meta + lista de temps; episodios opcional).
 * Por defecto NO baja episodios (maxSeasons=0 + skipEps implícito vía maxSeasons).
 * Usa maxSeasons / maxEpisodes para limitar.
 */
export async function scrapeOneSeries(series, options = {}) {
  const resolveServers = options.resolveServers !== false;
  const maxSeasons = options.maxSeasons || 0;
  const maxEpisodes = options.maxEpisodes || 0;
  const includeEpisodes = options.includeEpisodes === true;
  const seasonConcurrency = Math.max(1, parseInt(process.env.SEASON_CONCURRENCY || '2', 10));
  const episodeConcurrency = Math.max(1, parseInt(process.env.EPISODE_CONCURRENCY || '3', 10));
  const userDataDir = options.userDataDir || join(CONFIG.ROOT_DIR, '.browser-profile');

  const context = await launchContext(userDataDir);

  try {
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
    if (maxSeasons > 0) seasons = seasons.slice(0, maxSeasons);

    // Solo meta + lista de temporadas (sin episodios) — comportamiento actual deseado
    if (!includeEpisodes) {
      return {
        slug: meta.slug,
        url_directa: meta.url_directa,
        titulo: meta.titulo,
        imagen: meta.imagen,
        anio: meta.anio,
        resumen: meta.resumen,
        categoria: 'serie',
        generos: meta.generos,
        total_temporadas: seasons.length,
        total_episodios: 0,
        temporadas: seasons.map((s) => ({
          numero: s.numero,
          label: s.label,
          url: s.url,
          poster: s.poster || null,
          total_episodios: 0,
          episodios: []
        })),
        plataforma: 'Cuevana3',
        type: 'series',
        scrapedAt: new Date().toISOString(),
        status: 'ok'
      };
    }

    log(`  Temporadas: ${seasons.length} | resolve=${resolveServers}`);

    const seasonResults = await mapPool(seasons, seasonConcurrency, async (season) => {
      try {
        return await processSeason(context, season, {
          resolveServers,
          maxEpisodes,
          episodeConcurrency
        });
      } catch (e) {
        log(`    ERROR T${season.numero}: ${e.message}`);
        return {
          seasonData: {
            numero: season.numero,
            label: season.label,
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

    seasonResults.sort((a, b) => (a.seasonData.numero || 0) - (b.seasonData.numero || 0));

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
      serversResolution: resolveServers
        ? { total: totalSrv, resueltos: totalSrvOk, completo: totalSrv === 0 || totalSrvOk === totalSrv }
        : undefined,
      scrapedAt: new Date().toISOString(),
      status: 'ok'
    };
  } finally {
    await context.close().catch(() => {});
  }
}
