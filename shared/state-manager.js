/**
 * shared/state-manager.js
 * Persistencia de estado reutilizable para catálogos y detalles.
 * Usa escritura atómica para evitar corrupción de datos en cierres inesperados.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';

/**
 * Escribe un archivo de forma atómica (escribe en .tmp y luego renombra)
 * @param {string} filePath 
 * @param {string} data 
 */
export function atomicWrite(filePath, data) {
  const tempFile = `${filePath}.tmp`;
  writeFileSync(tempFile, data, 'utf8');
  renameSync(tempFile, filePath);
}

/**
 * Asegura que un directorio exista, creándolo recursivamente si es necesario
 * @param {string} dirPath 
 */
export function ensureDir(dirPath) {
  if (!dirPath) throw new Error('ensureDir: dirPath es undefined o inválido');
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

// ─── CATÁLOGO ─────────────────────────────────────────────────

export function loadCatalogState(stateFile, catalogUrl) {
  if (!existsSync(stateFile)) {
    return { visitedPages: [], queuedPages: [catalogUrl], moviesBySlug: {}, lastPage: 0 };
  }
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    return {
      visitedPages: state.visitedPages || [],
      queuedPages: state.queuedPages || [catalogUrl],
      moviesBySlug: state.moviesBySlug || {},
      lastPage: state.lastPage || 0
    };
  } catch {
    console.error(`[StateManager] Estado corrupto en ${stateFile}, reiniciando.`);
    return { visitedPages: [], queuedPages: [catalogUrl], moviesBySlug: {}, lastPage: 0 };
  }
}

export function saveCatalogState(stateFile, state) {
  atomicWrite(stateFile, JSON.stringify(state, null, 2));
}

export function saveCatalogData(outputFile, state, platformName) {
  const data = {
    metadata: {
      source: platformName,
      scrapedAt: new Date().toISOString(),
      pagesVisited: state.visitedPages.length,
      totalMovies: Object.keys(state.moviesBySlug).length
    },
    movies: Object.values(state.moviesBySlug)
  };
  atomicWrite(outputFile, JSON.stringify(data, null, 2));
}

// ─── DETALLES ─────────────────────────────────────────────────

export function loadDetailsState(stateFile) {
  if (!existsSync(stateFile)) {
    return { processedSlugs: new Set(), errorSlugs: new Set(), detailsById: {}, lastIndex: 0 };
  }
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
    return {
      processedSlugs: new Set(raw.processedSlugs || []),
      errorSlugs: new Set(raw.errorSlugs || []),
      detailsById: raw.detailsById || {},
      lastIndex: raw.lastIndex || 0
    };
  } catch {
    console.error(`[StateManager] Estado corrupto en ${stateFile}, reiniciando.`);
    return { processedSlugs: new Set(), errorSlugs: new Set(), detailsById: {}, lastIndex: 0 };
  }
}

export function saveDetailsState(stateFile, state) {
  const serializable = {
    processedSlugs: [...state.processedSlugs],
    errorSlugs: [...state.errorSlugs],
    detailsById: state.detailsById,
    lastIndex: state.lastIndex || 0,
    savedAt: new Date().toISOString()
  };
  atomicWrite(stateFile, JSON.stringify(serializable, null, 2));
}

export function saveDetailsOutput(outputFile, state, platformName) {
  const data = {
    metadata: {
      source: platformName,
      scrapedAt: new Date().toISOString(),
      totalDetails: Object.keys(state.detailsById).length,
      successful: state.processedSlugs.size,
      errors: state.errorSlugs.size
    },
    details: Object.values(state.detailsById)
  };
  atomicWrite(outputFile, JSON.stringify(data, null, 2));
}