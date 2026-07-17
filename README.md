<p align="center">
  <img src="brand/logo.png" alt="Movie Server" width="320" />
</p>

<p align="center">
  <a href="https://github.com/DevrajGajurel/ha-app-movie-server">
    <img src="https://img.shields.io/github/v/release/DevrajGajurel/ha-app-movie-server?label=release&style=for-the-badge" alt="Release" />
  </a>
  <a href="https://github.com/DevrajGajurel/ha-app-movie-server">
    <img src="https://img.shields.io/github/stars/DevrajGajurel/ha-app-movie-server?style=for-the-badge" alt="Stars" />
  </a>
  <img src="https://img.shields.io/badge/Home%20Assistant-2024.1%2B-41BDF5?style=for-the-badge&logo=home-assistant&logoColor=white" alt="Home Assistant" />
</p>

# Movie Server

Home Assistant integration for monitoring your **Movie Server** add-on: scrape health, source URL redirects, and download activity.

> **Requires a running Movie Server.** Install the [add-on](docs/add-on.md) first, then add this integration.

---

## Features

- Detect when the source site stops scraping
- Alert when `main_url` redirects to a new domain
- Track active and completed downloads
- Polls your local Movie Server every 30 seconds

---

## Installation

### HACS (recommended)

1. Open **HACS** → ⋮ → **Custom repositories**
2. Repository: `https://github.com/DevrajGajurel/ha-app-movie-server`
3. Category: **Integration**
4. Search **Movie Server** → **Download**
5. **Restart Home Assistant**
6. **Settings** → **Devices & services** → **Add integration** → **Movie Server**
7. URL: `http://movie_server:3001` (default when using the add-on)

### Manual

Copy `custom_components/movie_server` into your Home Assistant `config/custom_components/` folder, restart, then add the integration.

---

## Entities

| Entity | Type | Description |
|--------|------|-------------|
| `binary_sensor.movie_server_scrape_problem` | Problem | On when the source site cannot be scraped |
| `binary_sensor.movie_server_source_url_redirected` | Problem | On when `main_url` redirects; see `final_url` attribute |
| `sensor.movie_server_active_downloads` | Sensor | Queued / in-progress downloads |
| `sensor.movie_server_movies_on_page_1` | Sensor | Movies returned for page 1 |
| `sensor.movie_server_completed_downloads` | Sensor | Completed download jobs |

### Redirect notification example

```yaml
alias: Movie Server source URL changed
triggers:
  - trigger: state
    entity_id: binary_sensor.movie_server_source_url_redirected
    to: "on"
actions:
  - action: notify.mobile_app_your_phone
    data:
      title: Movie Server redirect detected
      message: >-
        Old: {{ state_attr('binary_sensor.movie_server_source_url_redirected', 'source_url') }}
        New: {{ state_attr('binary_sensor.movie_server_source_url_redirected', 'final_url') }}
```

---

## Related docs

| Topic | Link |
|-------|------|
| Install the add-on (dashboard + downloads) | [docs/add-on.md](docs/add-on.md) |
| Local development & API | [docs/development.md](docs/development.md) |
| Issues | [GitHub Issues](https://github.com/DevrajGajurel/ha-app-movie-server/issues) |

---

## License

Private / personal use. Respect source site terms and TMDB attribution requirements.
