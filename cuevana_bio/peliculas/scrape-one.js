/**
 * scrape-one.js — películas
 * Una película = meta + servidores resueltos (como un solo episodio).
 */
import { join } from 'node:path';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CONFIG, log } from '../../shared/config.js';
import {
  extractPeliculaDetalleFromDOM,
  extractServersFromTabsDOM
} from './extractor-peliculas.js';

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
    const iframeSrc = await page
      .evaluate(() => {
        const ifr = document.querySelector('iframe[src]');
        return ifr ? ifr.getAttribute('src') : null;
      })
      .catch(() => null);
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

/**
 * Scrapea una película: meta + servidores.
 * @param {object} movie - { slug, url_directa, titulo? }
 * @param {object} options
 */
export async function scrapeOneMovie(movie, options = {}) {
  const resolveServers = options.resolveServers !== false;
  const userDataDir = options.userDataDir || join(CONFIG.ROOT_DIR, '.browser-profile');

  const context = await chromium.launchPersistentContext(userDataDir, {
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

  const page = await context.newPage();
  await page
    .route('**/*.{png,jpg,jpeg,webp,gif,svg,ttf,woff,woff2,mp4,mp3}', (r) => r.abort())
    .catch(() => {});

  try {
    const url = movie.url_directa;
    log(`▶ Película: ${movie.titulo || movie.slug}`);
    await gotoSafe(page, url);
    const origin = await page.evaluate(() => location.origin);

    let meta = {};
    try {
      meta = await page.evaluate((fnStr) => {
        const fn = new Function('return (' + fnStr + ')')();
        return fn(document);
      }, extractPeliculaDetalleFromDOM.toString());
    } catch {
      meta = {};
    }

    let servers = [];
    try {
      servers = await page.evaluate((fnStr) => {
        const fn = new Function('return (' + fnStr + ')')();
        return fn(document);
      }, extractServersFromTabsDOM.toString());
    } catch {
      servers = [];
    }

    servers = (servers || []).map((s) => ({
      ...s,
      url: absUrl(s.url, origin)
    }));

    log(`  Servidores: ${servers.length} | resolve=${resolveServers}`);

    let resolved = servers;
    if (resolveServers && servers.length) {
      resolved = [];
      for (const srv of servers) {
        const r = await resolveSingleServer(page, srv);
        resolved.push(r);
        log(`    ${r.nombre}: ${r.resolved ? 'OK' : 'fail'} (${r.resolvedVia || r.resolveError || 'direct'})`);
      }
    }

    const nRes = resolved.filter((s) => s.resolved !== false).length;

    return {
      slug: movie.slug,
      url_directa: url,
      titulo: meta.titulo || movie.titulo || movie.slug,
      imagen: meta.imagen || movie.imagen || null,
      backdrop: meta.backdrop || null,
      anio: meta.anio || movie.anio || null,
      duracion: meta.duracion || null,
      resumen: meta.resumen || null,
      actores: meta.actores || null,
      generos: meta.generos || [],
      vote: meta.vote || null,
      categoria: 'pelicula',
      type: 'movie',
      plataforma: 'Cuevana3',
      servidores: resolved,
      serversResolution: resolveServers
        ? {
            total: servers.length,
            resueltos: nRes,
            completo: servers.length === 0 || nRes === servers.length
          }
        : undefined,
      scrapedAt: new Date().toISOString(),
      status: 'ok'
    };
  } finally {
    await context.close().catch(() => {});
  }
}
