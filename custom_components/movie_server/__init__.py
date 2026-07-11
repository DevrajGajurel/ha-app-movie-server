from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import CoordinatorEntity, DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL

_LOGGER = logging.getLogger(__name__)
PLATFORMS = ["sensor", "binary_sensor"]


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
        try:
            async with self.session.get(f"{self.base_url}/api/config", timeout=15) as response:
                response.raise_for_status()
                config = await response.json()

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

        return {
            "config": config,
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
