/**
 * series/extractor-series.js
 * Lógica pura de extracción para SERIES en Cuevana3.
 */
import { CONFIG } from '../../shared/config.js';

const BASE_URL = CONFIG.BASE_URL;

/**
 * Extrae series del DOM ajustado a la clase `.movie-item` y contenedor `bp="grid..."`
 */
export async function extractSeriesGrid(page) {
  return page.evaluate((baseUrl) => {
    const results = [];
    const seen = new Set();
    const items = document.querySelectorAll('.movie-item');

    items.forEach((item) => {
      const a = item.querySelector('a');
      if (!a) return;

      const href = a.getAttribute('href') || '';
      if (!href) return;

      const slugMatch = href.match(/\/serie\/([a-z0-9-]+)/i) || href.match(/\/series\/([a-z0-9-]+)/i);
      const slug = slugMatch ? slugMatch[1] : href.split('/').filter(Boolean).pop();
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      // Título: .item-detail p > alt de img
      const pTitle = item.querySelector('.item-detail p');
      const imgEl = item.querySelector('img.poster') || item.querySelector('img');
      const title = pTitle ? pTitle.textContent.trim() : (imgEl ? imgEl.getAttribute('alt') || '' : '');

      // Imagen
      const imagen = imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '') : '';

      // Año / Temporadas en span.year
      const yearSpan = item.querySelector('span.year');
      const seasonsOrYear = yearSpan ? yearSpan.textContent.trim() : null;

      const url_directa = href.startsWith('http') 
        ? href 
        : `${baseUrl.replace(/\/$/, '')}${href.startsWith('/') ? '' : '/'}${href}`;

      results.push({
        id: slug,
        titulo: title.replace(/^serie\s+/i, '').trim() || slug,
        slug,
        url_directa,
        imagen: imagen || null,
        anio: seasonsOrYear,
        plataforma: 'Cuevana3',
        type: 'series'
      });
    });

    return results;
  }, BASE_URL);
}

/**
 * Espera a que la grilla contenga elementos
 */
export async function waitForSeriesGrid(page) {
  try {
    await page.waitForSelector('.movie-item', { timeout: 12_000 });
  } catch {
    // Si la página no tiene elementos o llegó al final
  }
}

/**
 * Navega a la siguiente página haciendo clic en <a rel="next">Siguiente</a>
 * y maneja posibles retos intermedios de Cloudflare.
 */
export async function clickNextPage(page, previousFirstSlug) {
  // 1. Localizar y hacer clic en el botón Siguiente
  const clicked = await page.evaluate(() => {
    const nav = document.querySelector('nav .pagination') || 
                document.querySelector('.pagination') || 
                document.querySelector('nav');
    if (!nav) return false;

    const nextBtn = nav.querySelector('a[rel="next"]') || 
                    Array.from(nav.querySelectorAll('a')).find(a => a.textContent.trim().toLowerCase().includes('siguiente'));

    if (nextBtn) {
      nextBtn.click();
      return true;
    }
    return false;
  });

  if (!clicked) return false;

  // 2. Comprobar si Cloudflare bloqueó el paso a la página 2
  await page.waitForTimeout(2000); // Pequeña pausa para detectar si la página cambió a Cloudflare
  
  const isChallenge = await page.evaluate(() => {
    const title = document.title.toLowerCase();
    const body = document.body ? document.body.innerText.toLowerCase() : '';
    return title.includes('just a moment') || title.includes('attention required') || body.includes('verify you are human');
  }).catch(() => false);

  if (isChallenge) {
    console.log('\n⚠️ Cloudflare volvió a solicitar verificación al cambiar de página.');
    console.log('👉 Por favor, resuelve el captcha manualmente en la ventana del navegador...');
    
    try {
      // Espera activa hasta 60 segundos a que resuelvas el captcha en la pantalla
      await page.waitForFunction(() => {
        const title = document.title.toLowerCase();
        return !title.includes('just a moment') && !title.includes('attention required');
      }, { timeout: 60_000 });
      
      console.log('✅ Captcha resuelto. Continuando extracción...\n');
    } catch {
      console.log('❌ Se agotó el tiempo para resolver el captcha.');
      return false;
    }
  }

  // 3. Esperar a que el primer elemento del grid cambie
  try {
    await page.waitForFunction(
      (prevSlug) => {
        const firstItem = document.querySelector('.movie-item a');
        if (!firstItem) return false;
        const href = firstItem.getAttribute('href') || '';
        return href && !href.includes(prevSlug);
      },
      previousFirstSlug || '',
      { timeout: 15_000 }
    );
  } catch {
    await page.waitForTimeout(3000);
  }

  return true;
}

// ─── TEMPORADAS Y EPISODIOS ────────────────────────────────────

export async function extractSeasons(page) {
  await page.waitForFunction(() => {
    const selects = Array.from(document.querySelectorAll('select'));
    return selects.some((s) => Array.from(s.options).some((o) => /temporada/i.test(o.textContent || '')));
  }, { timeout: 15_000 }).catch(() => {});

  return page.evaluate(() => {
    let best = null;
    let bestCount = 0;
    for (const s of document.querySelectorAll('select')) {
      const n = Array.from(s.options).filter((o) => /temporada/i.test(o.textContent || '') || /^\d+$/.test((o.value || '').trim())).length;
      if (n > bestCount) {
        bestCount = n;
        best = s;
      }
    }
    if (!best) return [];
    return Array.from(best.options)
      .map((opt) => ({
        value: (opt.value || '').trim(),
        label: (opt.textContent || '').trim()
      }))
      .filter((s) => s.value !== '' && s.label);
  });
}

export async function selectSeason(page, seasonValue) {
  await page.evaluate((val) => {
    const select = document.querySelector('select');
    if (!select) return;
    select.value = String(val);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, seasonValue);
  await page.waitForTimeout(1000);
}

export async function extractEpisodesFromGrid(page, seriesSlug, seasonNum) {
  return page.evaluate(({ baseUrl, seriesSlug, seasonNum }) => {
    const result = [];
    document.querySelectorAll('a[href*="/episodio/"]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const slug = href.replace(/^\/episodio\//, '').replace(/\/$/, '');
      if (!slug) return;
      const titulo = (a.querySelector('h3')?.textContent || '').trim() || slug;
      const img = a.querySelector('img');
      const poster = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
      const url_directa = href.startsWith('http') ? href : `${baseUrl.replace(/\/$/, '')}${href.startsWith('/') ? '' : '/'}${href}`;
      
      result.push({ 
        id: slug, 
        slug, 
        titulo, 
        url_directa, 
        poster: poster || null, 
        temporada: seasonNum, 
        serie_slug: seriesSlug 
      });
    });
    return result;
  }, { baseUrl: BASE_URL, seriesSlug, seasonNum });
}

export async function extractEpisodeServers(page, logFn = null) {
  const log = (m) => (typeof logFn === 'function' ? logFn(m) : console.log(`[Srv] ${m}`));
  const servidores = [];

  try {
    const hasPlayer = await page.waitForSelector('#player', { timeout: 10_000 }).then(() => true).catch(() => false);
    if (!hasPlayer) return servidores;

    const outerSrc = await page.evaluate(() => {
      const iframe = document.querySelector('#player iframe');
      return iframe ? iframe.getAttribute('src') : '';
    });

    if (outerSrc) {
      servidores.push({ nombre: 'default', calidad: 'HD', url: outerSrc });
    }
  } catch (e) {
    log(`ERROR: ${e.message}`);
  }
  return servidores;
}

export async function extractEpisodeDetails(page, epMeta = {}, logFn = null) {
  const servidores = await extractEpisodeServers(page, logFn);
  return {
    slug: epMeta.slug,
    url_directa: epMeta.url_directa,
    titulo: epMeta.titulo,
    servidores,
    scrapedAt: new Date().toISOString()
  };
}