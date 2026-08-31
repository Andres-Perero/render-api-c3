/**
 * shared/config.js
 * Config central. Cada plataforma vive en su carpeta:
 *   cinelatino/peliculas | cinelatino/series
 *   cuevana3/peliculas  | cuevana3/series
 *
 * PLATFORM=cinelatino|cuevana3  (o se infiere de la ruta del script)
 */
import dotenv from 'dotenv';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

const ENV_PATHS = [
  resolve(process.cwd(), '.env'),
  resolve(ROOT_DIR, '.env'),
  resolve(__dirname, '.env'),
];

let envLoaded = false;
for (const p of ENV_PATHS) {
  if (existsSync(p)) {
    dotenv.config({ path: p, override: true });
    envLoaded = true;
    break;
  }
}
if (!envLoaded) dotenv.config({ override: true });

const PLATFORM = (process.env.PLATFORM || 'cinelatino').toLowerCase().trim();

const PLATFORM_URLS = {
  cinelatino: 'https://cinelatino.net',
  cuevana3: 'https://cuevana3.gs',
  cuevana_bio: 'https://cuevana3i.bio'
};

const PLATFORM_DOMAINS = {
  cinelatino: 'cinelatino.net',
  cuevana3: 'cuevana3.gs',
   cuevana_bio: 'cuevana3i.bio'
};

export const CONFIG = {
  PLATFORM,
  ROOT_DIR,
  BASE_URL: process.env.BASE_URL || PLATFORM_URLS[PLATFORM],
  USER_AGENT:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  // Datos por plataforma (aislados)
  DATA_DIR: join(ROOT_DIR, PLATFORM, 'data'),
  PELICULAS_DATA_DIR: join(ROOT_DIR, PLATFORM, 'peliculas', 'data'),
  SERIES_DATA_DIR: join(ROOT_DIR, PLATFORM, 'series', 'data'),
  CF_CONFIG_PATH: join(ROOT_DIR, 'cf-config.json'),

  CONCURRENCY: parseInt(process.env.CONCURRENCY || '5', 10),
  REQUEST_DELAY_MS: parseInt(process.env.REQUEST_DELAY_MS || '4000', 10),
  RETRIES: parseInt(process.env.RETRIES || '2', 10),
  START_PAGE: parseInt(process.env.START_PAGE || '1', 10),
  MAX_PAGES: parseInt(process.env.MAX_PAGES || '0', 10),
  SAVE_EVERY_N: parseInt(process.env.SAVE_EVERY_N || '10', 10),
};

export function loadCfConfig() {
  if (!existsSync(CONFIG.CF_CONFIG_PATH)) {
    return { cookie: '', userAgent: CONFIG.USER_AGENT };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG.CF_CONFIG_PATH, 'utf8'));
    return {
      cookie: raw.cookie || '',
      userAgent: raw.userAgent || CONFIG.USER_AGENT
    };
  } catch {
    return { cookie: '', userAgent: CONFIG.USER_AGENT };
  }
}

export function parseCookies(cookieHeader) {
  if (!cookieHeader) return [];
  const domain = PLATFORM_DOMAINS[CONFIG.PLATFORM] || PLATFORM_DOMAINS.cinelatino;
  return cookieHeader.split(';').map((part) => {
    const idx = part.indexOf('=');
    if (idx < 1) return null;
    return {
      name: part.slice(0, idx).trim(),
      value: part.slice(idx + 1).trim(),
      domain,
      path: '/',
      secure: true
    };
  }).filter(Boolean);
}

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
