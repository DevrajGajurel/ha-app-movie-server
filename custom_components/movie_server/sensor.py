from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
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
    async_add_entities(
        [
            MovieServerActiveDownloadsSensor(coordinator, entry.entry_id),
            MovieServerMoviesSensor(coordinator, entry.entry_id),
            MovieServerCompletedDownloadsSensor(coordinator, entry.entry_id),
            MovieServerSourceFinalUrlSensor(coordinator, entry.entry_id),
        ]
    )


class MovieServerActiveDownloadsSensor(MovieServerEntity, SensorEntity):
    _attr_name = "Active downloads"
    _attr_icon = "mdi:download"
    _attr_native_unit_of_measurement = "downloads"
    _attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def unique_id(self) -> str:
        return f"{self._entry_id}_active_downloads"

    @property
    def native_value(self) -> int:
        return self.coordinator.data["active_downloads"]


class MovieServerMoviesSensor(MovieServerEntity, SensorEntity):
    _attr_name = "Movies on page 1"
    _attr_icon = "mdi:movie-open"
    _attr_native_unit_of_measurement = "movies"
    _attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def unique_id(self) -> str:
        return f"{self._entry_id}_movies"

    @property
    def native_value(self) -> int:
        return self.coordinator.data["movie_count"]

    @property
    def extra_state_attributes(self) -> dict:
        config = self.coordinator.data.get("config", {})
        return {
            "source_url": config.get("mainUrl"),
            "max_pages": config.get("maxPages"),
        }


class MovieServerCompletedDownloadsSensor(MovieServerEntity, SensorEntity):
    _attr_name = "Completed downloads"
    _attr_icon = "mdi:check-circle"
    _attr_native_unit_of_measurement = "downloads"
    _attr_state_class = SensorStateClass.TOTAL_INCREASING

    @property
    def unique_id(self) -> str:
        return f"{self._entry_id}_completed_downloads"

    @property
    def native_value(self) -> int:
        return self.coordinator.data["completed_downloads"]


class MovieServerSourceFinalUrlSensor(MovieServerEntity, SensorEntity):
    """Always shows where the configured main_url currently resolves."""

    _attr_name = "Source final URL"
    _attr_icon = "mdi:link-variant"

    @property
    def unique_id(self) -> str:
        return f"{self._entry_id}_source_final_url"

    @property
    def native_value(self) -> str | None:
        return self.coordinator.data.get("source_redirect_url") or self.coordinator.data.get(
            "source_url"
        )

    @property
    def extra_state_attributes(self) -> dict:
        return {
            "source_url": self.coordinator.data.get("source_url"),
            "redirected": self.coordinator.data.get("source_redirected"),
            "last_error": self.coordinator.data.get("source_redirect_error"),
        }
