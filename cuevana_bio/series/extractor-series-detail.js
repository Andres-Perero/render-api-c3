/**
 * series/extractor-series-detail.js
 * Detalle serie + episodios por temporada + servidores (tabs-video)
 * Sitio: cuevana3l.biz / cuevana_bio
 */
import { parse } from "node-html-parser";

/**
 * Parsea HTML de la página de detalle de serie.
 */
export function parseCuevanaSerieDetalle(htmlString) {
  const root = parse(htmlString);

  const temporadas = root
    .querySelectorAll(".objects-item a")
    .map((el) => {
      const img = el.querySelector("img");
      const spanText = el.querySelector("p span")?.text?.trim() || null;
      const href = el.getAttribute("href") || null;
      const numero = spanText ? parseInt(spanText, 10) || spanText : null;
      return {
        numero,
        label: spanText ? `Temporada ${spanText}` : null,
        url: href,
        poster: img ? img.getAttribute("src") : null,
      };
    })
    .filter((t) => t.url);

  const firstHeader = root.querySelector(".subtitle");
  const totalTemporadasText = firstHeader
    ? (firstHeader.childNodes?.[0]?.text || firstHeader.text || "").trim()
    : null;
  let totalTemporadas = temporadas.length;
  if (totalTemporadasText) {
    const m = totalTemporadasText.match(/(\d+)\s*Temporada/i);
    if (m) totalTemporadas = parseInt(m[1], 10);
  }

  // Buscar el header de Categoría
  const catHeader = root
    .querySelectorAll(".subtitle")
    .find((h) => (h.text || "").includes("Categoría"));

  // Buscar todos los enlaces <a> dentro del siguiente elemento hermano
  const categoria =
    catHeader?.nextElementSibling
      ?.querySelectorAll("a")
      .map((a) => a.text.trim()) || [];

  let titulo =
    root.querySelector("h1")?.text?.trim() ||
    root.querySelector(".title-detail h1")?.text?.trim() ||
    null;
  if (titulo) titulo = titulo.replace(/^Serie\s+/i, "").trim();

  const imgMain =
    root.querySelector("img.poster") ||
    root.querySelector(".item-picture img") ||
    root.querySelector('img[src*="tmdb"]');
  const imagen = imgMain ? imgMain.getAttribute("src") : null;

  const getSectionText = (titleText) => {
    const headers = root.querySelectorAll(".subtitle");
    const header = headers.find((h) => (h.text || "").includes(titleText));
    if (!header) return null;
    const nextElem = header.nextElementSibling;
    return nextElem ? (nextElem.text || "").trim() : null;
  };
  // Extraer el texto completo
  const estrenoRaw = getSectionText("Año de estreno");

  // Extraer únicamente los 4 dígitos numéricos seguidos
  const estrenoAño = estrenoRaw ? estrenoRaw.match(/\d{4}/)?.[0] || null : null;

  // 1. Obtienes el texto completo usando tu función existente
  const estrenoTexto = getSectionText("Año de estreno");

  // 2. Extraes únicamente la secuencia de 4 dígitos (ej. "1999")
  const anio = estrenoTexto
    ? estrenoTexto.match(/\d{4}/)?.[0] || null
    : null;

  return {
    titulo,
    imagen,
    total_temporadas: totalTemporadas,
    totalTemporadasText: totalTemporadasText || null,
    temporadas,
    resumen: getSectionText("Resumen general"),
    estreno: estrenoAño,
    anio,
    categoria,
    generos: categoria ? [categoria] : [],
  };
}

/** DOM vivo – detalle de serie */
export function extractSerieDetalleFromDOM() {
  const clean = (v = "") => (v || "").replace(/\s+/g, " ").trim();

  const temporadas = [];
  document.querySelectorAll(".objects-item a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!href) return;
    const span = a.querySelector("p span");
    const spanText = span ? clean(span.textContent) : null;
    const img = a.querySelector("img");
    const numero = spanText ? parseInt(spanText, 10) || spanText : null;
    temporadas.push({
      numero,
      label: spanText ? `Temporada ${spanText}` : null,
      url: href,
      poster: img ? img.getAttribute("src") : null,
    });
  });

  const getSectionText = (titleText) => {
    const headers = Array.from(document.querySelectorAll(".subtitle"));
    const header = headers.find((h) =>
      (h.textContent || "").includes(titleText),
    );
    if (!header) return null;
    const next = header.nextElementSibling;
    return next ? clean(next.textContent) : null;
  };

  const firstHeader = document.querySelector(".subtitle");
  const totalText = firstHeader
    ? clean(firstHeader.childNodes?.[0]?.textContent || firstHeader.textContent)
    : null;
  let totalTemporadas = temporadas.length;
  if (totalText) {
    const m = totalText.match(/(\d+)\s*Temporada/i);
    if (m) totalTemporadas = parseInt(m[1], 10);
  }

  const catHeader = Array.from(document.querySelectorAll(".subtitle")).find(
    (h) => (h.textContent || "").includes("Categoría"),
  );

  // Extraer un arreglo con todas las categorías: ["Accion", "Comedia", "Ciencia Ficcion", ...]
  const categoriasNodeList =
    catHeader?.nextElementSibling?.querySelectorAll("a");
  const categorias = categoriasNodeList
    ? Array.from(categoriasNodeList).map((link) => clean(link.textContent))
    : [];

  let titulo =
    clean(document.querySelector("h1")?.textContent) ||
    clean(document.querySelector(".title-detail h1")?.textContent) ||
    null;
  if (titulo) titulo = titulo.replace(/^Serie\s+/i, "").trim();

  const imgMain =
    document.querySelector("img.poster") ||
    document.querySelector(".item-picture img") ||
    document.querySelector('img[src*="tmdb"]');
  const imagen = imgMain ? imgMain.getAttribute("src") : null;

  return {
    titulo,
    imagen,
    total_temporadas: totalTemporadas,
    totalTemporadasText: totalText || null,
    temporadas,
    resumen: getSectionText("Resumen general"),
    estreno: getSectionText("Año de estreno"),
    categoria: "serie",
    generos: categorias,
  };
}

/**
 * Extrae lista de episodios desde la página de una temporada.
 * Selectores flexibles para /temporada-N
 */
export function extractEpisodesFromSeasonDOM() {
  const clean = (v = "") => (v || "").replace(/\s+/g, " ").trim();
  const seen = new Set();
  const result = [];

  // Solo links de episodio real: /serie/.../episodio-1x1 (no /episodios/recientes)
  const links = document.querySelectorAll('a[href*="episodio-"]');

  for (const a of links) {
    const href = a.getAttribute("href") || "";
    // Debe contener episodio-NxN y pertenecer a una serie
    if (
      !/\/serie\/[^/]+\/episodio-\d+x\d+/i.test(href) &&
      !/episodio-\d+x\d+/i.test(href)
    )
      continue;
    if (/\/episodios\//i.test(href) || /recientes/i.test(href)) continue;

    const sx = href.match(/episodio-(\d+)x(\d+)/i);
    if (!sx) continue;

    const temporada = parseInt(sx[1], 10);
    const episodio = parseInt(sx[2], 10);
    const slug = `${temporada}x${episodio}`;
    if (seen.has(slug)) continue;
    seen.add(slug);

    const titulo =
      clean(a.querySelector("h3, .title, p, .item-detail p")?.textContent) ||
      clean(a.getAttribute("title")) ||
      clean(a.querySelector("img")?.getAttribute("alt")) ||
      `Episodio ${episodio}`;

    const img = a.querySelector("img");
    const poster = img
      ? img.getAttribute("src") || img.getAttribute("data-src") || null
      : null;

    result.push({
      slug,
      titulo,
      url_directa: href,
      poster,
      temporada,
      episodio,
      numero: episodio,
    });
  }

  result.sort((a, b) => {
    if (a.temporada !== b.temporada)
      return (a.temporada || 0) - (b.temporada || 0);
    return (a.episodio || 0) - (b.episodio || 0);
  });

  return result;
}

/**
 * Extrae servidores desde ul.tabs-video (página de episodio).
 * Estructura real de cuevana3l.biz
 */
export function extractServersFromTabsDOM() {
  const clean = (v = "") => (v || "").replace(/\s+/g, " ").trim();
  const servidores = [];
  const seen = new Set();

  document
    .querySelectorAll("ul.tabs-video > li.tab-video-item")
    .forEach((tab) => {
      const nameEl = tab.querySelector(".tab-item-name");
      let idioma = "Latino";
      let calidad = "HD";
      if (nameEl) {
        // Texto principal del tab (primer nodo de texto)
        const full = clean(nameEl.textContent);
        // Calidad suele ir en un div interno
        const qualityDiv = nameEl.querySelector("div");
        if (qualityDiv) {
          const qText = clean(qualityDiv.textContent);
          const qm = qText.match(
            /(?:Calidad\s*[·•-]?\s*)?(HD|SD|4K|1080|720|480|Premiere)/i,
          );
          if (qm) calidad = qm[1];
          // idioma = full sin el texto de calidad
          idioma =
            clean(full.replace(qText, "")) ||
            full.split(/\s{2,}/)[0] ||
            "Latino";
        } else {
          idioma = full || "Latino";
        }
      }

      // Icono lat/sub puede ayudar
      const img = tab.querySelector(".tab-item-image");
      const imgSrc = img ? img.getAttribute("src") || "" : "";
      if (/sub/i.test(imgSrc) && !/latino/i.test(idioma)) {
        if (!idioma || idioma === "Latino") idioma = "Subtitulado";
      }

      tab
        .querySelectorAll('ul li[data-server], ul li[role="presentation"]')
        .forEach((li) => {
          const url = li.getAttribute("data-server") || "";
          if (!url || seen.has(url)) return;
          seen.add(url);

          const spans = Array.from(li.querySelectorAll("span")).map((s) =>
            clean(s.textContent),
          );
          const nombre =
            spans.find((t) => t && !/^reproducir$/i.test(t)) ||
            clean(li.textContent)
              .replace(/reproducir/i, "")
              .trim() ||
            "Servidor";

          servidores.push({
            nombre,
            idioma,
            calidad,
            url,
          });
        });
    });

  return servidores;
}

/**
 * Parse HTML string de episodio → servidores (node-html-parser)
 */
export function parseEpisodeServers(htmlString) {
  const root = parse(htmlString);
  const servidores = [];
  const seen = new Set();

  root.querySelectorAll("ul.tabs-video > li.tab-video-item").forEach((tab) => {
    const nameEl = tab.querySelector(".tab-item-name");
    let idioma = "Latino";
    let calidad = "HD";
    if (nameEl) {
      const full = (nameEl.text || "").replace(/\s+/g, " ").trim();
      const qualityDiv = nameEl.querySelector("div");
      if (qualityDiv) {
        const qText = (qualityDiv.text || "").trim();
        const qm = qText.match(
          /(?:Calidad\s*[·•-]?\s*)?(HD|SD|4K|1080|720|480|Premiere)/i,
        );
        if (qm) calidad = qm[1];
        idioma = full.replace(qText, "").trim() || "Latino";
      } else {
        idioma = full || "Latino";
      }
    }

    const img = tab.querySelector(".tab-item-image");
    const imgSrc = img ? img.getAttribute("src") || "" : "";
    if (/sub/i.test(imgSrc) && !/latino/i.test(idioma)) {
      if (!idioma || idioma === "Latino") idioma = "Subtitulado";
    }

    tab
      .querySelectorAll('ul li[data-server], ul li[role="presentation"]')
      .forEach((li) => {
        const url = li.getAttribute("data-server") || "";
        if (!url || seen.has(url)) return;
        seen.add(url);
        const spans = li.querySelectorAll("span");
        let nombre = "Servidor";
        for (const sp of spans) {
          const t = (sp.text || "").trim();
          if (t && !/^reproducir$/i.test(t)) {
            nombre = t;
            break;
          }
        }
        servidores.push({ nombre, idioma, calidad, url });
      });
  });

  return servidores;
}
