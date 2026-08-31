/**
 * shared/drive-client.js
 *
 * Auth SOLO por env (sin archivo en el repo):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  → JSON completo de la service account
 *
 * Alternativa (campos sueltos):
 *   GOOGLE_CLIENT_EMAIL
 *   GOOGLE_PRIVATE_KEY
 *   GOOGLE_PROJECT_ID (opcional)
 *
 * Local opcional:
 *   GOOGLE_SERVICE_ACCOUNT_FILE → ruta a service-account.json
 */
import { google } from 'googleapis';
import { readFileSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';

const SCOPES = ['https://www.googleapis.com/auth/drive'];
let _driveClient = null;

function loadServiceAccountKey() {
  // ── 1) JSON completo en una sola env ───────────────────────
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (rawJson && rawJson.trim()) {
    const key = JSON.parse(rawJson);
    if (key.private_key && key.private_key.includes('\\n')) {
      key.private_key = key.private_key.replace(/\\n/g, '\n');
    }
    return key;
  }

  // ── 2) Campos sueltos en env ───────────────────────────────
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (email && privateKey) {
    // Render a veces guarda con comillas envolventes
    privateKey = privateKey.replace(/^["']|["']$/g, '');
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }
    return {
      type: 'service_account',
      project_id: process.env.GOOGLE_PROJECT_ID || 'storage-web-scraping',
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID || '',
      private_key: privateKey,
      client_email: email,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token'
    };
  }

  // ── 3) Archivo local (solo desarrollo) ─────────────────────
  const credentialsPath =
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './service-account.json';
  const resolved = path.resolve(credentialsPath);
  if (existsSync(resolved)) {
    return JSON.parse(readFileSync(resolved, 'utf8'));
  }

  throw new Error(
    'Sin credenciales de Drive. Define en Render: ' +
      'GOOGLE_SERVICE_ACCOUNT_JSON (JSON completo) ' +
      'o GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY'
  );
}

export function getDriveClient() {
  if (_driveClient) return _driveClient;

  const key = loadServiceAccountKey();
  const auth = new google.auth.JWT(key.client_email, null, key.private_key, SCOPES);
  _driveClient = google.drive({ version: 'v3', auth });
  return _driveClient;
}

export async function findFileInFolder(folderId, fileName) {
  const drive = getDriveClient();
  const safeName = fileName.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `'${folderId}' in parents and name = '${safeName}' and trashed = false`,
    fields: 'files(id, name, modifiedTime)',
    spaces: 'drive'
  });
  const files = res.data.files || [];
  return files.length ? files[0].id : null;
}

export async function uploadOrUpdateFile(folderId, fileName, localFilePath, mimeType = 'application/json') {
  const drive = getDriveClient();
  const existingId = await findFileInFolder(folderId, fileName);
  const media = { mimeType, body: createReadStream(localFilePath) };

  if (existingId) {
    const res = await drive.files.update({
      fileId: existingId,
      media,
      fields: 'id, name, modifiedTime'
    });
    return { action: 'updated', ...res.data };
  }

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media,
    fields: 'id, name, modifiedTime'
  });
  return { action: 'created', ...res.data };
}

export async function downloadFile(folderId, fileName, destLocalPath) {
  const drive = getDriveClient();
  const fileId = await findFileInFolder(folderId, fileName);
  if (!fileId) return null;

  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    const dest = createWriteStream(destLocalPath);
    res.data.on('end', resolve).on('error', reject).pipe(dest);
  });
  return fileId;
}

export async function getJsonFromDrive(folderId, fileName) {
  const drive = getDriveClient();
  const fileId = await findFileInFolder(folderId, fileName);
  if (!fileId) return null;

  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  const chunks = [];
  await new Promise((resolve, reject) => {
    res.data.on('data', (c) => chunks.push(c));
    res.data.on('end', resolve);
    res.data.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
