# API – series + películas

| Método | Ruta | Qué hace |
|--------|------|----------|
| GET | `/health` | Healthcheck |
| GET | `/api/catalog/series` | Catálogo series |
| GET | `/api/catalog/movies` | Catálogo películas |
| GET | `/api/series/:slug` | Meta + lista temps |
| GET | `/api/series/:slug/temp1` | Caps T1 + servers resueltos |
| GET | `/api/movies/:slug` | Meta + servers resueltos |

## Ejemplos

```bash
# series
curl http://localhost:3000/api/series/futurama
curl http://localhost:3000/api/series/futurama/temp1

# películas
curl http://localhost:3000/api/movies/la-guerra-de-los-ultimos
curl "http://localhost:3000/api/movies/la-guerra-de-los-ultimos?resolve=0"

# catálogos
curl http://localhost:3000/api/catalog/series
curl http://localhost:3000/api/catalog/movies
```

## Catálogo local / Drive

```bash
npm run catalogo:series   # → series.json (+ Drive)
npm run catalogo:movies   # → peliculas.json (+ Drive)
```

## Flujo UI películas

1. Grid desde `/api/catalog/movies`
2. Click película → `/api/movies/{slug}` → poster, resumen, servidores listos
