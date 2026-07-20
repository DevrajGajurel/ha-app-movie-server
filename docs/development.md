# Development

## Local Docker

```powershell
copy .env.example .env
docker compose up --build -d
```

Open http://localhost:3001

## Windows without Docker

```powershell
copy .env.example .env
.\start.ps1
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAIN_URL` | — | Source site URL (required) |
| `PORT` | `3001` | Host port |
| `MAX_PAGES` | `1` | Listing pages to fetch |
| `INITIAL_PAGES` | `2` | Pages loaded immediately without cache |
| `TMDB_API_KEY` | — | Optional TMDB key |
| `REDIS_URL` | — | Optional Redis listing cache |
| `DOWNLOAD_DIR` | `/downloads` | Download folder in container |
| `DOWNLOAD_HOST_PATH` | `D:/HA/PlexMedia` | Host path for Docker volume |

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard |
| `GET` | `/api/config` | Current config (includes scrape health) |
| `PUT` | `/api/config` | Update config |
| `GET` | `/api/movies?from=1&to=2` | Movies for page range (from Redis when configured) |
| `GET` | `/api/movies?from=1&to=2&refresh=1` | Force live scrape |
| `GET` | `/api/movies/search?q=...` | Scrape source `search.html?search=...` and return matches |
| `GET` | `/api/redirect?url=...` | Resolve HTTP redirects |
| `GET` | `/api/downloads?url=...` | Quality download options |
| `POST` | `/api/downloads/save` | Start background download |
| `GET` | `/api/downloads/jobs` | Download job status |
| `GET` | `/api/downloads/library` | Scanned downloaded movies |
| `GET` | `/api/emby/status` | Whether Emby refresh is configured |
| `POST` | `/api/emby/refresh` | Trigger full Emby library scan |

## Repository layout

```
├── hacs.json
├── brand/
├── repository.yaml
├── movie-server/
├── src/movie_server/
└── custom_components/movie_server/
```
