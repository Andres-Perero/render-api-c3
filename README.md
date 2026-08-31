# Multi-Platform Scraper

## Estructura

```
proyecto/
├── shared/                 # config, state-manager, drive, http (común)
├── cinelatino/
│   ├── peliculas/          # extractor, scrape-catalogo, scrape-detalles, ...
│   │   └── data/           # se crea al correr (catalogo.json, details.json, ...)
│   └── series/             # (base a adaptar; por ahora clones de cuevana)
│       └── data/
├── cuevana3/
│   ├── peliculas/
│   │   └── data/
│   └── series/
│       └── data/
├── cf-config.json
├── .env
└── package.json
```

## Uso

```bash
# Cinelatino películas
npm run cinelatino:catalogo
GENERO=accion npm run cinelatino:catalogo
npm run cinelatino:detalles
ONLY_SLUG=mi-peli npm run cinelatino:detalles

# Cuevana3 películas
npm run cuevana3:catalogo
npm run cuevana3:detalles

# Series
npm run cuevana3:series:catalogo
npm run cinelatino:series:catalogo   # pendiente adaptar selectors Cinelatino
```

Datos de cada plataforma quedan aislados en `plataforma/peliculas/data` y `plataforma/series/data`.
