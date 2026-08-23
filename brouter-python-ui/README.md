# BRouter Python UI

A local Flask and Leaflet interface for BRouter with route editing, GPX import/export,
elevation profiles, surface enrichment, and OpenStreetMap POIs.

## Requirements

- Python 3.12+
- A BRouter HTTP service
- BRouter profile files (the default path is `../misc/profiles2`)

Install and run with a locked development environment:

```bash
uv sync --dev
uv run flask --app app run
```

For production, run the Flask application through a production WSGI server. Debug mode is
disabled by default and should not be enabled on a publicly reachable service.

## Configuration

Configuration is read from environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROUTER_URL` | `http://localhost:17777/brouter` | BRouter endpoint |
| `BROUTER_PROFILES_DIR` | `../misc/profiles2` | BRouter profile directory |
| `BROUTER_TIMEOUT_S` | `60` | BRouter request timeout |
| `OVERPASS_URL` | Overpass API | Primary Overpass endpoint |
| `OVERPASS_FALLBACK_URLS` | Two public mirrors | Comma-separated fallbacks |
| `OVERPASS_TIMEOUT_S` | `35` | Per-endpoint Overpass timeout |
| `MAX_CONTENT_LENGTH` | `2097152` | Maximum request body bytes |
| `MAX_ROUTE_POINTS` | `100` | Maximum routed waypoints |
| `MAX_ENRICH_POINTS` | `10000` | Maximum surface-enrichment coordinates |
| `MAX_BBOX_SPAN_DEG` | `2` | Maximum latitude/longitude query span |
| `RATE_LIMIT_REQUESTS` | `30` | Requests allowed per client and endpoint window |
| `RATE_LIMIT_WINDOW_S` | `60` | In-memory rate-limit window |
| `POI_CACHE_TTL_S` | `120` | POI cache lifetime |
| `POI_CACHE_MAX` | `120` | Maximum process-local POI cache entries |
| `LOG_LEVEL` | `INFO` | Python logging level |

The built-in rate limiter and POI cache are process-local. Deployments with multiple workers
should place a shared rate limiter in the reverse proxy or replace these stores with shared
infrastructure.

## Verification

```bash
uv run pytest
uv run ruff check .
```

Tests mock BRouter and avoid contacting public Overpass services.
