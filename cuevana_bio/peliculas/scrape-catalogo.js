/**
 * peliculas/scrape-catalogo.js
 * Grid /peliculas → peliculas.json (+ Drive)
 */
import { join } from 'node:path';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CONFIG, log } from '../../shared/config.js';
import {
  loadCatalogState,
  saveCatalogState,
  saveCatalogData,
  ensureDir
} from '../../shared/state-manager.js';

chromium.use(stealthPlugin());

const CATALOG_PATH = '/peliculas';
const HARD_MAX_PAGES = 935;
const SAVE_EVERY_N_PAGES = 50;
const CONCURRENCY = Math.max(1, CONFIG.CONCURRENCY || 5);

const STATE_FILE = join(CONFIG.PELICULAS_DATA_DIR, 'peliculas-state.json');
const OUTPUT_FILE = join(CONFIG.PELICULAS_DATA_DIR, 'peliculas.json');
const USER_DATA_DIR = join(CONFIG.ROOT_DIR, '.browser-profile');

function parseDOMItems(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const elements = root.querySelectorAll('.movie-item, article');
  const results = [];
  const seen = new Set();

  for (const item of elements) {
    const a = item.querySelector('a');
    if (!a) continue;
    const href = a.getAttribute('href') || '';
    if (!/\/pelicula\//i.test(href)) continue;

    const slugMatch = href.match(/\/pelicula\/([a-z0-9-]+)/i);
    const slug = slugMatch ? slugMatch[1] : href.split('/').filter(Boolean).pop();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const pTitle = item.querySelector('.item-detail p');
    const imgEl = item.querySelector('img.poster') || item.querySelector('img');
    let titulo = pTitle
      ? pTitle.textContent.trim()
      : imgEl
        ? imgEl.getAttribute('alt') || ''
        : '';
    titulo = titulo.replace(/^pel[ií]cula\s+/i, '').trim() || slug;

    const imagen = imgEl
      ? imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || null
      : null;
    const yearSpan = item.querySelector('span.year');
    const anio = yearSpan ? yearSpan.textContent.trim() : null;

    results.push({
      id: slug,
      slug,
      titulo,
      url_directa: href,
      imagen,
      anio,
      plataforma: 'Cuevana3',
      type: 'movie'
    });
  }
  return results;
}

async function fetchAndParsePage(page, url, parserFnStr) {
  return page.evaluate(
    async ({ url, parserFnStr }) => {
      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin'
          }
        });
        if (res.status !== 200) return { ok: false, status: res.status, items: [] };
        const html = await res.text();
        const fn = new Function('return (' + parserFnStr + ')')();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return { ok: true, status: 200, items: fn(doc) };
      } catch (err) {
        return { ok: false, status: 0, error: err.message, items: [] };
      }
    },
    { url, parserFnStr }
  );
}

function mergeItems(state, items, realOrigin) {
  let added = 0;
  for (const item of items) {
    if (item.url_directa && !item.url_directa.startsWith('http')) {
      item.url_directa = `${realOrigin}${item.url_directa.startsWith('/') ? '' : '/'}${item.url_directa}`;
    }
    if (item.slug && !state.moviesBySlug[item.slug]) {
      state.moviesBySlug[item.slug] = item;
      added++;
    }
  }
  return added;
}

async function main() {
  log('=== INICIO scrape-catalogo películas ===');
  log(`PLATFORM=${CONFIG.PLATFORM} BASE_URL=${CONFIG.BASE_URL} CONCURRENCY=${CONCURRENCY}`);

  ensureDir(CONFIG.PELICULAS_DATA_DIR);
  ensureDir(USER_DATA_DIR);

  let state = loadCatalogState(STATE_FILE, `${CONFIG.BASE_URL}${CATALOG_PATH}`);
  if (!state.moviesBySlug) state.moviesBySlug = {};
  if (!state.visitedPages) state.visitedPages = [];
  log(`Estado previo: ${Object.keys(state.moviesBySlug).length} películas`);

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

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  const startUrl = `${CONFIG.BASE_URL}${CATALOG_PATH}`;
  log(`goto → ${startUrl}`);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  log(`Cargada: title="${await page.title()}" url=${page.url()}`);

  const isBlocked = await page.evaluate(() =>
    /just a moment|cloudflare|attention required/i.test(document.title)
  );
  if (isBlocked) {
    log('⚠️ Cloudflare. Resuelve captcha (120s)...');
    await page.waitForFunction(
      () => !/just a moment|attention required/i.test(document.title),
      { timeout: 120_000 }
    );
    log('✅ Captcha OK');
  }

  try {
    await page.waitForSelector('.movie-item a[href*="/pelicula/"]', { timeout: 15_000 });
    log('✅ Grid películas OK');
  } catch {
    const diag = await page.evaluate(() => ({
      title: document.title,
      items: document.querySelectorAll('.movie-item').length
    }));
    log(`⚠️ Sin grid. Diag: ${JSON.stringify(diag)}`);
  }
  await page.waitForTimeout(1000);

  const realOrigin = await page.evaluate(() => location.origin);
  log(`Origen real: ${realOrigin}`);

  const parserFnStr = parseDOMItems.toString();
  const targetEndPage = CONFIG.MAX_PAGES > 0 ? CONFIG.MAX_PAGES : HARD_MAX_PAGES;
  let newItemsCount = 0;
  let pagesProcessedCount = 0;
  let emptyStreak = 0;

  // Página 1
  log('Extrayendo página 1 (DOM)...');
  let items = await page.evaluate((fnStr) => {
    const fn = new Function('return (' + fnStr + ')')();
    return fn(document);
  }, parserFnStr);

  let added = mergeItems(state, items, realOrigin);
  newItemsCount += added;
  pagesProcessedCount++;
  const url1 = `${realOrigin}${CATALOG_PATH}?page=1`;
  if (!state.visitedPages.includes(url1)) state.visitedPages.push(url1);
  log(`[1/${targetEndPage}] ${items.length} películas (+${added} nuevas)`);

  if (items.length === 0) {
    log('Página 1 vacía. Abortando.');
    await context.close();
    return;
  }

  for (let start = 2; start <= targetEndPage; start += CONCURRENCY) {
    const end = Math.min(start + CONCURRENCY - 1, targetEndPage);
    const pageNums = [];
    for (let p = start; p <= end; p++) pageNums.push(p);

    log(`Chunk páginas ${pageNums[0]}–${pageNums[pageNums.length - 1]}...`);

    const results = await Promise.all(
      pageNums.map(async (pageNum) => {
        const url = `${realOrigin}${CATALOG_PATH}?page=${pageNum}`;
        const result = await fetchAndParsePage(page, url, parserFnStr);
        return { pageNum, url, ...result };
      })
    );

    let chunkEmpty = true;
    for (const r of results) {
      if (r.ok && r.items.length > 0) {
        chunkEmpty = false;
        emptyStreak = 0;
        const addedPage = mergeItems(state, r.items, realOrigin);
        newItemsCount += addedPage;
        if (!state.visitedPages.includes(r.url)) state.visitedPages.push(r.url);
        pagesProcessedCount++;
        log(`[${r.pageNum}/${targetEndPage}] ${r.items.length} (+${addedPage} nuevas)`);
      } else {
        log(`[${r.pageNum}] vacío/error status=${r.status || 0} ${r.error || ''}`);
        emptyStreak++;
      }
    }

    if (chunkEmpty || emptyStreak >= CONCURRENCY) {
      log('Fin del catálogo.');
      break;
    }

    if (pagesProcessedCount % SAVE_EVERY_N_PAGES < CONCURRENCY) {
      saveCatalogState(STATE_FILE, state);
      saveCatalogData(OUTPUT_FILE, state, 'Cuevana3 - Películas');
      log('>>> Guardado intermedio');
    }

    await page.waitForTimeout(CONFIG.REQUEST_DELAY_MS || 1500);
  }

  saveCatalogState(STATE_FILE, state);
  saveCatalogData(OUTPUT_FILE, state, 'Cuevana3 - Películas');
  await context.close();

  const driveFolder =
    process.env.DRIVE_FOLDER_PELICULAS ||
    process.env.DRIVE_FOLDER_SERIES ||
    process.env.DRIVE_FOLDER_CUEVANA3 ||
    '';
  if (driveFolder) {
    try {
      const { uploadOrUpdateFile } = await import('../../shared/drive-client.js');
      const result = await uploadOrUpdateFile(driveFolder, 'peliculas.json', OUTPUT_FILE);
      log(`Drive peliculas.json → ${result.action} (id=${result.id})`);
    } catch (e) {
      log(`⚠️ No se pudo subir a Drive: ${e.message}`);
    }
  }

  log('========================================');
  log('COMPLETADO: Películas');
  log(`Total: ${Object.keys(state.moviesBySlug).length}`);
  log(`Nuevas: ${newItemsCount}`);
  log(`Archivo: ${OUTPUT_FILE}`);
  log('========================================');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
