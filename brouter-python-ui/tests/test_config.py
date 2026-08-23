import pytest

from brouter_ui.config import load_settings


def test_settings_deduplicate_overpass_urls():
    settings = load_settings(
        {
            "OVERPASS_URL": "https://one.example/api",
            "OVERPASS_FALLBACK_URLS": "https://one.example/api, https://two.example/api",
        }
    )
    assert settings.overpass_fallbacks == (
        "https://one.example/api",
        "https://two.example/api",
    )


def test_settings_reject_nonpositive_limits():
    with pytest.raises(ValueError, match="MAX_ROUTE_POINTS"):
        load_settings({"MAX_ROUTE_POINTS": "0"})


def test_default_gpx_limit_is_25_mib():
    assert load_settings({}).max_gpx_file_size == 25 * 1024 * 1024
