/**
 * shared/drive-client.js
 * Cliente de Google Drive reutilizable usando Service Account.
 * Requiere: npm install googleapis
 * Variable de entorno: GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json
 */
import { google } from 'googleapis';
import { readFileSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';

const SCOPES = ['https://www.googleapis.com/auth/drive'];
let _driveClient = null;

/**
 * Crea o reutiliza el cliente autenticado de Drive
 * @param {string} credentialsPath 
 * @returns {import('googleapis').drive_v3.Drive}
 */
export function getDriveClient(credentialsPath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './service-account.json') {
  if (_driveClient) return _driveClient;
  
  const resolved = path.resolve(credentialsPath);
  if (!existsSync(resolved)) {
    throw new Error(`No se encontró el archivo de credenciales: ${resolved}`);
  }
  
  const key = JSON.parse(readFileSync(resolved, 'utf8'));
  const auth = new google.auth.JWT(key.client_email, null, key.private_key, SCOPES);
  _driveClient = google.drive({ version: 'v3', auth });
  return _driveClient;
}

/**
 * Busca un archivo por nombre dentro de una carpeta de Drive
 * @param {string} folderId 
 * @param {string} fileName 
 * @returns {Promise<string|null>} fileId o null
 */
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

/**
 * Sube o actualiza un archivo en Drive
 * @param {string} folderId 
 * @param {string} fileName 
 * @param {string} localFilePath 
 * @param {string} mimeType 
 * @returns {Promise<{action: string, id: string, name: string}>}
 */
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

/**
 * Descarga un archivo de Drive a una ruta local
 * @param {string} folderId 
 * @param {string} fileName 
 * @param {string} destLocalPath 
 * @returns {Promise<string|null>} fileId descargado o null
 */
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

/**
 * Obtiene contenido JSON directamente desde Drive sin escribir a disco
 * @param {string} folderId 
 * @param {string} fileName 
 * @returns {Promise<object|null>}
 */
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