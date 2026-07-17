# Movie Server add-on

Install the **add-on** for the dashboard, downloads, and TMDB poster browser.

## Install

1. Settings → Add-ons → Add-on Store → ⋮ → **Repositories**
2. Add: `https://github.com/DevrajGajurel/ha-app-movie-server`
3. Install **Movie Server**, configure options, start it
4. Open the dashboard from the add-on page or the sidebar

## Configuration

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

## Redis listing cache

Set `redis_url` in the add-on configuration. The server caches listing pages, refreshes every 4 hours, and serves the full poster grid from cache. **Refresh** in the UI always scrapes live (`refresh=1`).

## Emby library refresh

| Option | Example |
|--------|---------|
| `emby_url` | `http://192.168.1.10:8096` |
| `emby_api_key` | From Emby → Dashboard → Advanced → API Keys |

When configured, Movie Server notifies Emby after each download. Use `POST /api/emby/refresh` for a full scan.
