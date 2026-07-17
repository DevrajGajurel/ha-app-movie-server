from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any
from urllib.parse import quote

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import CoordinatorEntity, DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL

_LOGGER = logging.getLogger(__name__)
PLATFORMS = ["sensor", "binary_sensor"]


def _normalize_redirect_url(value: str | None) -> str:
    return (value or "").rstrip("/")


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = MovieServerCoordinator(hass, entry.data[CONF_URL])
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok


class MovieServerCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    def __init__(self, hass: HomeAssistant, base_url: str) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.base_url = base_url.rstrip("/")
        self.session = async_get_clientsession(hass)

    async def _async_update_data(self) -> dict[str, Any]:
        redirect_payload: dict[str, Any] = {}

        try:
            async with self.session.get(f"{self.base_url}/api/config", timeout=15) as response:
                response.raise_for_status()
                config = await response.json()

            main_url = config.get("mainUrl")
            if main_url:
                try:
                    encoded_url = quote(main_url, safe="")
                    async with self.session.get(
                        f"{self.base_url}/api/redirect?url={encoded_url}", timeout=20
                    ) as response:
                        response.raise_for_status()
                        redirect_payload = await response.json()
                except Exception as err:
                    _LOGGER.warning("Failed to resolve Movie Server source redirect: %s", err)
                    redirect_payload = {"error": str(err)}

            async with self.session.get(
                f"{self.base_url}/api/movies?from=1&to=1", timeout=60
            ) as response:
                response.raise_for_status()
                movies = await response.json()

            async with self.session.get(f"{self.base_url}/api/downloads/jobs", timeout=15) as response:
                response.raise_for_status()
                jobs_payload = await response.json()
        except Exception as err:
            raise UpdateFailed(f"Error talking to Movie Server: {err}") from err

        jobs = jobs_payload.get("jobs", [])
        active = [job for job in jobs if job.get("status") in ("queued", "downloading")]
        completed = [job for job in jobs if job.get("status") == "completed"]
        failed = [job for job in jobs if job.get("status") == "failed"]
        source_url = config.get("mainUrl")
        redirected_url = redirect_payload.get("url")

        return {
            "config": config,
            "source_redirected": bool(
                source_url
                and redirected_url
                and _normalize_redirect_url(source_url) != _normalize_redirect_url(redirected_url)
            ),
            "source_url": source_url,
            "source_redirect_url": redirected_url,
            "source_redirect_error": redirect_payload.get("error"),
            "movie_count": len(movies.get("movies", [])),
            "active_downloads": len(active),
            "completed_downloads": len(completed),
            "failed_downloads": len(failed),
            "jobs": jobs,
        }


class MovieServerEntity(CoordinatorEntity[MovieServerCoordinator]):
    def __init__(self, coordinator: MovieServerCoordinator, entry_id: str) -> None:
        super().__init__(coordinator)
        self._entry_id = entry_id
