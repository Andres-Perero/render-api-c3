/**
 * shared/http-client.js
 * Cliente HTTP nativo reutilizable con soporte de redirects y detección de bloqueos.
 * Útil para requests ligeros donde no se requiere Playwright.
 */
import https from 'node:https';
import { URL } from 'node:url';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Realiza una petición GET con soporte de redirects automáticos
 * @param {string} url 
 * @param {object} config 
 * @param {number} redirectsLeft 
 * @returns {Promise<{status: number, html: string}>}
 */
export function httpGet(url, config = {}, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const { cookie = '', userAgent = DEFAULT_USER_AGENT, referer = '', timeout = 30000 } = config;
    
    let settled = false;
    let totalTimeout;
    const finish = (cb, val) => {
      if (!settled) {
        settled = true;
        clearTimeout(totalTimeout);
        cb(val);
      }
    };

    const request = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
        ...(referer ? { Referer: referer } : {})
      },
      timeout
    }, (response) => {
      const status = response.statusCode || 0;
      
      // Manejo de redirects
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        clearTimeout(totalTimeout);
        httpGet(new URL(response.headers.location, target).href, config, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', (err) => finish(reject, err));
      response.on('end', () => finish(resolve, { status, html: Buffer.concat(chunks).toString('utf8') }));
    });

    request.on('timeout', () => request.destroy(new Error('Timeout')));
    request.on('error', (err) => finish(reject, err));
    totalTimeout = setTimeout(() => request.destroy(new Error('Tiempo máximo agotado')), timeout + 5000);
    request.end();
  });
}

/**
 * Detecta si una respuesta indica bloqueo por Cloudflare o similar
 * @param {{status: number, html: string}} param0 
 * @returns {boolean}
 */
export function isBlocked({ status, html }) {
  return !html || status === 403 || status === 503 ||
    /just a moment|cf-challenge|verificacion de seguridad|checking your browser/i.test(html);
}

/**
 * Obtiene HTML validando automáticamente bloqueos y errores HTTP
 * @param {object} config 
 * @param {string} url 
 * @param {string} logPrefix 
 * @returns {Promise<string>}
 */
export async function fetchHtml(config, url, logPrefix = '') {
  const response = await httpGet(url, config);
  if (isBlocked(response)) throw new Error(`${logPrefix}Bloqueado (HTTP ${response.status}): ${url}`);
  if (response.status < 200 || response.status >= 400) throw new Error(`${logPrefix}HTTP ${response.status}: ${url}`);
  return response.html;
}