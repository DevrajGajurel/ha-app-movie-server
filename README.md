# Movie Server

Home Assistant **add-on** (dashboard + downloads) and optional **HACS integration** (sensors).

Scrapes movie/TV listings, enriches with TMDB metadata, and downloads to your media folder.

## Install with HACS (sensors)

Use HACS for the custom integration that creates entities like scrape health and download counts.

1. HACS → ⋮ → **Custom repositories**
2. Repository: `https://github.com/DevrajGajurel/ha-app-movie-server`
3. Type: **Integration**
4. Download **Movie Server**, then restart Home Assistant
5. Settings → Devices & services → Add integration → **Movie Server**
6. URL: `http://movie_server:3001` (add-on default) or your server URL

### Entities

| Entity | Description |
|--------|-------------|
| `binary_sensor.movie_server_scrape_problem` | On when the source site cannot be scraped |
| `binary_sensor.movie_server_source_url_redirected` | On when `main_url` redirects; `final_url` shows the new URL |
| `sensor.movie_server_active_downloads` | Queued / in-progress downloads |
| `sensor.movie_server_movies_on_page_1` | Movies returned for page 1 |
| `sensor.movie_server_completed_downloads` | Completed download jobs |

> The integration talks to a running Movie Server. Install the **add-on** below (or run local Docker) first.

## Install the add-on (app / dashboard)

1. Settings → Add-ons → Add-on Store → ⋮ → **Repositories**
2. Add: `https://github.com/DevrajGajurel/ha-app-movie-server`
3. Install **Movie Server**, configure options, start it
4. Open the dashboard from the add-on page or the sidebar

### Add-on configuration

| Option | Required | Description |
|--------|----------|-------------|
| `main_url` | Yes | Source listing URL to scrape |
| `tmdb_api_key` | No | TMDB API key for posters and filters |
| `max_pages` | No | Pages to fetch (default `5`) |
| `initial_pages` | No | Pages loaded first without Redis (default `2`) |
| `download_dir` | No | Download folder (default `/media`) |
| `redis_url` | No | Redis URL for listing cache |
| `emby_url` / `emby_api_key` | No | Emby library refresh after downloads |
| `hd_keywords` / `k4_keywords` | No | Quality badge keywords |

Downloads are saved under `download_dir` (default HA `/media`).

## Repository layout

```
├── hacs.json                 # HACS integration metadata
├── brand/icon.png            # HACS / HA brand asset
├── repository.yaml           # HA add-on store manifest
├── movie-server/             # Home Assistant add-on
├── src/movie_server/         # Application source
└── custom_components/        # HACS integration (sensors)
    └── movie_server/
```

## Local development (Docker Compose)

```powershell
copy .env.example .env
docker compose up --build -d
```

Open http://localhost:3001

### Windows without Docker

```powershell
copy .env.example .env
.\start.ps1
```

### Environment variables

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
| `GET` | `/api/redirect?url=...` | Resolve HTTP redirects |
| `GET` | `/api/downloads?url=...` | Quality download options |
| `POST` | `/api/downloads/save` | Start background download |
| `GET` | `/api/downloads/jobs` | Download job status |
| `GET` | `/api/downloads/library` | Scanned downloaded movies |
| `GET` | `/api/emby/status` | Whether Emby refresh is configured |
| `POST` | `/api/emby/refresh` | Trigger full Emby library scan |

## Emby library refresh

Set in add-on **Configuration** (optional):

| Option | Example |
|--------|---------|
| `emby_url` | `http://192.168.1.10:8096` |
| `emby_api_key` | From Emby → Dashboard → Advanced → API Keys |

When configured, Movie Server notifies Emby after each download. Use `POST /api/emby/refresh` for a full scan.

## Redis listing cache (optional)

Set `REDIS_URL` in `.env` (local) or `redis_url` in the HA add-on. The server caches listing pages, refreshes every 4 hours, and serves the full poster grid from cache. **Refresh** in the UI always scrapes live (`refresh=1`).

## License

Private / personal use. Respect source site terms and TMDB attribution requirements.
