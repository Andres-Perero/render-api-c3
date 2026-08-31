/**
 * extractor-peliculas.js
 * Selectores para detalle de película (cuevana3l.biz)
 */

export function extractPeliculaDetalleFromDOM() {
  const clean = (v = '') => (v || '').replace(/\s+/g, ' ').trim();

  let titulo =
    clean(document.querySelector('h1.title, h1.page-title-hero, h1')?.textContent) || null;
  if (titulo) titulo = titulo.replace(/\s*\d+\.?\d*\s*$/, '').trim(); // quita vote score pegado

  const imgMain =
    document.querySelector('.backdrop-info img') ||
    document.querySelector('img.poster') ||
    document.querySelector('figure img');
  const imagen = imgMain ? imgMain.getAttribute('src') : null;

  const backdrop =
    document.querySelector('.backdrop-image img')?.getAttribute('src') || null;

  // Resumen: primer <p> dentro de backdrop-info
  const resumenEl = document.querySelector('.backdrop-info p');
  const resumen = resumenEl ? clean(resumenEl.textContent) : null;

  const getSectionText = (titleText) => {
    const headers = Array.from(document.querySelectorAll('.subtitle, h2'));
    const header = headers.find((h) => (h.textContent || '').includes(titleText));
    if (!header) return null;
    const next = header.nextElementSibling;
    return next ? clean(next.textContent) : null;
  };

  const anio = getSectionText('Año de estreno') || getSectionText('estreno');
  const duracion = getSectionText('Cuánto dura') || getSectionText('Duración');
  const actores = getSectionText('Actores');

  // Categorías / géneros
  const catHeader = Array.from(document.querySelectorAll('.subtitle, h2')).find((h) =>
    /Categor/i.test(h.textContent || '')
  );
  const generos = catHeader?.nextElementSibling
    ? Array.from(catHeader.nextElementSibling.querySelectorAll('a')).map((a) =>
        clean(a.textContent)
      )
    : [];

  const vote =
    clean(document.querySelector('.voteav')?.textContent) ||
    clean(document.querySelector('[title="Puntuación"]')?.textContent) ||
    null;

  return {
    titulo,
    imagen,
    backdrop,
    resumen,
    anio,
    duracion,
    actores,
    generos,
    vote
  };
}

/**
 * Servidores desde ul.tabs-video (misma estructura que series/episodios)
 */
export function extractServersFromTabsDOM() {
  const clean = (v = '') => (v || '').replace(/\s+/g, ' ').trim();
  const servidores = [];
  const seen = new Set();

  document.querySelectorAll('ul.tabs-video > li.tab-video-item').forEach((tab) => {
    const nameEl = tab.querySelector('.tab-item-name');
    let idioma = 'Latino';
    let calidad = 'HD';
    if (nameEl) {
      const full = clean(nameEl.textContent);
      const qualityDiv = nameEl.querySelector('div');
      if (qualityDiv) {
        const qText = clean(qualityDiv.textContent);
        const qm = qText.match(/(?:Calidad\s*[·•-]?\s*)?(HD|SD|4K|1080|720|480|CAM|Premiere)/i);
        if (qm) calidad = qm[1];
        idioma = clean(full.replace(qText, '')) || full.split(/\s{2,}/)[0] || 'Latino';
      } else {
        idioma = full || 'Latino';
      }
    }

    const img = tab.querySelector('.tab-item-image');
    const imgSrc = img ? img.getAttribute('src') || '' : '';
    if (/sub/i.test(imgSrc) && !/latino/i.test(idioma)) {
      if (!idioma || idioma === 'Latino') idioma = 'Subtitulado';
    }

    tab.querySelectorAll('ul li[data-server], ul li[role="presentation"]').forEach((li) => {
      const url = li.getAttribute('data-server') || '';
      if (!url || seen.has(url)) return;
      seen.add(url);

      const spans = Array.from(li.querySelectorAll('span')).map((s) => clean(s.textContent));
      const nombre =
        spans.find((t) => t && !/^reproducir$/i.test(t)) ||
        clean(li.textContent).replace(/reproducir/i, '').trim() ||
        'Servidor';

      servidores.push({ nombre, url, idioma, calidad });
    });
  });

  return servidores;
}
