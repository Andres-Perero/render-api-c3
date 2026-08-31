# Sincronización con Google Drive

Se agregaron 3 archivos nuevos:

- `shared/drive-client.js` — cliente reutilizable de Drive (auth con service account).
- `cinelatino/sync-drive.js` — script independiente para subir/descargar los JSON de cinelatino.
- `cuevana3/sync-drive.js` — script independiente para subir/descargar los JSON de cuevana3.
- `api-server.js` — servidor HTTP que expone los JSON generados como API.

## 1. Instalar dependencias

```bash
npm install
```

(agrega `googleapis`, ya está en `package.json`)

## 2. Configurar `.env.local`

Ya tiene `GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json` (el archivo de credenciales
va en la raíz del proyecto, ya incluido en el zip).

**Falta que completes los IDs de las subcarpetas** `cinelatino` y `cuevana3` dentro de tu
carpeta `ServerAPI/peliculas` en Drive:

1. Entra a esa carpeta en Drive → abre la subcarpeta `cinelatino`.
2. Copia el ID que aparece en la URL: `https://drive.google.com/drive/folders/ESTE_ES_EL_ID`
3. Pégalo en `.env.local` en `DRIVE_FOLDER_CINELATINO=`.
4. Repite lo mismo para `cuevana3` → `DRIVE_FOLDER_CUEVANA3=`.

⚠️ Verifica que la carpeta esté compartida con
`basedatos-plataformas@storage-web-scraping.iam.gserviceaccount.com` con permiso de
**Editor** (no solo lector), porque los scripts necesitan poder crear/actualizar archivos.

## 3. Subir o descargar manualmente (scripts independientes)

```bash
# Cinelatino
node cinelatino/sync-drive.js upload all       # sube data.json + details.json (crea o actualiza)
node cinelatino/sync-drive.js upload data       # solo data.json
node cinelatino/sync-drive.js download all      # trae ambos desde Drive a ./cinelatino/data

# Cuevana3
node cuevana3/sync-drive.js upload all
node cuevana3/sync-drive.js download all
```

También quedaron como atajos npm:

```bash
npm run cinelatino:upload
npm run cinelatino:download
npm run cuevana3:upload
npm run cuevana3:download
```

## 4. Consumir como API

```bash
npm run api
# API server escuchando en http://localhost:3000
```

Endpoints:

```
GET /api/cinelatino/data              # data.json local
GET /api/cinelatino/details           # details.json local
GET /api/cinelatino/data?source=drive # lo trae directo de Drive, sin descargarlo antes
GET /api/cuevana3/data
GET /api/cuevana3/details
GET /api/cuevana3/data?source=drive
```

## Nota de seguridad

El archivo `service-account.json` es una credencial real con acceso a tu Drive. Ya quedó
excluido en `.gitignore` para que no se suba por accidente a un repo. Como esa clave se
compartió en un chat, te recomiendo **rotarla** desde Google Cloud Console
(IAM → Cuentas de servicio → esa cuenta → Claves → genera una nueva y borra la antigua) y
reemplazar el archivo local con la nueva.
