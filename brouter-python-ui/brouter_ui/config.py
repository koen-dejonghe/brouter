import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _positive_int(environ: Mapping[str, str], name: str, default: int) -> int:
    value = int(environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _positive_float(environ: Mapping[str, str], name: str, default: float) -> float:
    value = float(environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


@dataclass(frozen=True)
class Settings:
    brouter_url: str
    overpass_url: str
    overpass_fallbacks: tuple[str, ...]
    profiles_dir: Path
    poi_cache_ttl_s: int
    poi_cache_max: int
    poi_min_zoom: int
    brouter_timeout_s: float
    overpass_timeout_s: float
    max_route_points: int
    max_enrich_points: int
    max_bbox_span_deg: float
    max_track_name_len: int
    rate_limit_window_s: int
    rate_limit_requests: int
    max_content_length: int


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if environ is None else environ
    overpass_url = env.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
    candidates = [
        overpass_url,
        *env.get(
            "OVERPASS_FALLBACK_URLS",
            "https://lz4.overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter",
        ).split(","),
    ]
    fallbacks = tuple(dict.fromkeys(url.strip() for url in candidates if url.strip()))
    return Settings(
        brouter_url=env.get("BROUTER_URL", "http://localhost:17777/brouter"),
        overpass_url=overpass_url,
        overpass_fallbacks=fallbacks,
        profiles_dir=Path(
            env.get("BROUTER_PROFILES_DIR", str(PROJECT_ROOT.parent / "misc" / "profiles2"))
        ),
        poi_cache_ttl_s=_positive_int(env, "POI_CACHE_TTL_S", 120),
        poi_cache_max=_positive_int(env, "POI_CACHE_MAX", 120),
        poi_min_zoom=_positive_int(env, "POI_MIN_ZOOM", 12),
        brouter_timeout_s=_positive_float(env, "BROUTER_TIMEOUT_S", 60),
        overpass_timeout_s=_positive_float(env, "OVERPASS_TIMEOUT_S", 35),
        max_route_points=_positive_int(env, "MAX_ROUTE_POINTS", 100),
        max_enrich_points=_positive_int(env, "MAX_ENRICH_POINTS", 10000),
        max_bbox_span_deg=_positive_float(env, "MAX_BBOX_SPAN_DEG", 2),
        max_track_name_len=_positive_int(env, "MAX_TRACK_NAME_LEN", 100),
        rate_limit_window_s=_positive_int(env, "RATE_LIMIT_WINDOW_S", 60),
        rate_limit_requests=_positive_int(env, "RATE_LIMIT_REQUESTS", 30),
        max_content_length=_positive_int(env, "MAX_CONTENT_LENGTH", 2097152),
    )
