# Movie Server Home Assistant Add-on Repository

This repository contains a Home Assistant add-on for running **Movie Server** — scrape movie/TV listings, enrich with TMDB metadata, and download to your media folder.

Before publishing, confirm GitHub values in:

- `repository.yaml`
- `movie-server/config.yaml` (`url`)
- `movie-server/Dockerfile` (`APP_GIT_URL`, `APP_GIT_REF`)

## Add this repository to Home Assistant

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Open the menu (three dots) and click **Repositories**.
3. Add: `https://github.com/DevrajGajurel/ha-app-movie-server`
4. Install **Movie Server** from the add-on store.
5. Configure options and start the add-on.
6. Open the dashboard from the add-on page or the **Movie Server** sidebar entry.

## Configuration

| Option | Required | Description |
|--------|----------|-------------|
| `main_url` | Yes | Source listing URL to scrape |
| `tmdb_api_key` | No | TMDB API key for posters and filters |
| `max_pages` | No | Pages to fetch (default `5`) |
| `initial_pages` | No | Optional advanced — pages loaded first (default `2`) |
| `download_dir` | No | Server download folder (default `/media`) |
| `hd_keywords` / `k4_keywords` | No | Optional advanced — quality badge keywords |

Downloads are saved under `download_dir` (default HA `/media` folder).

## Optional: Home Assistant integration (sensors)

Copy `custom_components/movie_server` to your HA `config/custom_components/` folder, restart, then add the **Movie Server** integration with URL `http://movie_server:3001`.

Sensors: active downloads, movies on page 1, completed downloads.

## Repository layout

```
├── repository.yaml          # HA add-on store manifest
├── movie-server/            # Home Assistant add-on
│   ├── config.yaml
│   ├── Dockerfile
│   ├── rootfs/              # s6 startup scripts
│   └── CHANGELOG.md
├── src/movie_server/        # Application source
│   ├── main.js
│   ├── public/
│   └── package.json
└── custom_components/       # Optional HA sensors integration
```

---

## Local development (Docker Compose)

For running outside Home Assistant on your PC:

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
| `INITIAL_PAGES` | `2` | Pages loaded immediately |
| `TMDB_API_KEY` | — | Optional TMDB key |
| `DOWNLOAD_DIR` | `/downloads` | Download folder in container |
| `DOWNLOAD_HOST_PATH` | `D:/HA/PlexMedia` | Host path for Docker volume |

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard |
| `GET` | `/api/config` | Current config |
| `PUT` | `/api/config` | Update config |
| `GET` | `/api/movies?from=1&to=2` | Movies for page range |
| `GET` | `/api/downloads?url=...` | Quality download options |
| `POST` | `/api/downloads/save` | Start background download |
| `GET` | `/api/downloads/jobs` | Download job status |

## License

Private / personal use. Respect source site terms and TMDB attribution requirements.
