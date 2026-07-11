from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import MovieServerCoordinator, MovieServerEntity
from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: MovieServerCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([MovieServerScrapeProblemSensor(coordinator, entry.entry_id)])


class MovieServerScrapeProblemSensor(MovieServerEntity, BinarySensorEntity):
    """On when the source site can't be scraped (e.g. a dead/rotated mirror domain).

    This is tracked independently of the Redis cache, because a warm cache
    keeps serving stale data (and every request "succeeding") for hours
    after the source domain has died — exactly when this needs to surface.
    """

    _attr_name = "Scrape problem"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    @property
    def unique_id(self) -> str:
        return f"{self._entry_id}_scrape_problem"

    @property
    def is_on(self) -> bool:
        config = self.coordinator.data.get("config", {})
        return not config.get("scrapeOk", True)

    @property
    def extra_state_attributes(self) -> dict:
        config = self.coordinator.data.get("config", {})
        return {
            "source_url": config.get("mainUrl"),
            "last_error": config.get("scrapeLastError"),
            "last_error_at": config.get("scrapeLastErrorAt"),
            "last_success_at": config.get("scrapeLastSuccessAt"),
        }
