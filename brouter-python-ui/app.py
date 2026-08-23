import json
import logging
import os
import re
import time
from collections import defaultdict, deque
from math import atan2, cos, isfinite, pi, sqrt
from pathlib import Path
from threading import Lock
from xml.sax.saxutils import escape as xml_escape

import requests
from flask import Flask, Response, jsonify, render_template, request
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from werkzeug.utils import secure_filename

app = Flask(__name__)

BROUTER_URL = os.getenv("BROUTER_URL", "http://localhost:17777/brouter")
OVERPASS_URL = os.getenv("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
OVERPASS_FALLBACKS = [
    OVERPASS_URL,
    *[
        url.strip()
        for url in os.getenv(
            "OVERPASS_FALLBACK_URLS",
            "https://lz4.overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter",
        ).split(",")
        if url.strip() and url.strip() != OVERPASS_URL
    ],
]
PROFILES_DIR = Path(
    os.getenv(
        "BROUTER_PROFILES_DIR",
        str(Path(__file__).parent.parent / "misc" / "profiles2"),
    )
)
POI_CACHE_TTL_S = int(os.getenv("POI_CACHE_TTL_S", "120"))
POI_CACHE_MAX = int(os.getenv("POI_CACHE_MAX", "120"))
POI_MIN_ZOOM = int(os.getenv("POI_MIN_ZOOM", "12"))
BROUTER_TIMEOUT_S = float(os.getenv("BROUTER_TIMEOUT_S", "60"))
OVERPASS_TIMEOUT_S = float(os.getenv("OVERPASS_TIMEOUT_S", "35"))
MAX_ROUTE_POINTS = int(os.getenv("MAX_ROUTE_POINTS", "100"))
MAX_ENRICH_POINTS = int(os.getenv("MAX_ENRICH_POINTS", "10000"))
MAX_BBOX_SPAN_DEG = float(os.getenv("MAX_BBOX_SPAN_DEG", "2"))
MAX_TRACK_NAME_LEN = int(os.getenv("MAX_TRACK_NAME_LEN", "100"))
RATE_LIMIT_WINDOW_S = int(os.getenv("RATE_LIMIT_WINDOW_S", "60"))
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "30"))
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_CONTENT_LENGTH", "2097152"))
_POI_CACHE: dict[str, tuple[float, dict]] = {}
_POI_CACHE_LOCK = Lock()
_RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)
_RATE_LOCK = Lock()

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

HTTP = requests.Session()
HTTP.headers.update({"User-Agent": "brouter-python-ui/1.0", "Accept": "application/json"})
HTTP.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=1,
            connect=1,
            read=0,
            status=1,
            backoff_factor=0.2,
            status_forcelist=(429, 502, 503, 504),
            allowed_methods=frozenset({"GET"}),
        )
    ),
)

PROFILE_OVERRIDE_RE = re.compile(r"^profile:[A-Za-z_][A-Za-z0-9_]{0,63}$")
DOWNLOAD_FORMATS = {
    "gpx": ("application/gpx+xml", "gpx"),
    "kml": ("application/vnd.google-earth.kml+xml", "kml"),
    "geojson": ("application/geo+json", "geojson"),
    "csv": ("text/tab-separated-values", "csv"),
}

PROFILES = [
    "trekking",
    "trekking-noferries",
    "trekking-nosteps",
    "trekking-steep",
    "fastbike",
    "fastbike-lowtraffic",
    "fastbike-verylowtraffic",
    "mtb",
    "gravel",
    "hiking-mountain",
    "car-fast",
    "car-eco",
    "moped",
    "safety",
    "shortest",
    "skating",
]

# Matches lines like:
#   assign varname = value   # %varname% | description | type
_PARAM_RE = re.compile(
    r"^assign\s+(\w+)\s*=?\s*(\S+)\s*#\s*%\1%\s*\|\s*([^|]+)\|\s*(.+)$"
)


def parse_profile_params(profile: str) -> list[dict]:
    """Parse configurable parameters from a .brf profile file."""
    brf = PROFILES_DIR / f"{profile}.brf"
    if not brf.exists():
        return []

    params = []
    seen = set()
    for line in brf.read_text(encoding="utf-8").splitlines():
        m = _PARAM_RE.match(line.strip())
        if not m:
            continue
        name, default, description, type_hint = (g.strip() for g in m.groups())
        if name in seen:
            continue
        seen.add(name)

        type_hint = type_hint.strip()

        if type_hint == "boolean":
            kind = "boolean"
            default = default.lower() == "true"
            options = None
        elif type_hint == "number":
            kind = "number"
            try:
                default = float(default)
                if default == int(default):
                    default = int(default)
            except ValueError:
                pass
            options = None
        elif type_hint.startswith("[") and type_hint.endswith("]"):
            # e.g. [0=none, 1=auto-choose, 2=locus-style, ...]
            kind = "enum"
            try:
                default = int(default)
            except ValueError:
                pass
            raw = type_hint[1:-1]
            options = []
            for part in raw.split(","):
                part = part.strip()
                if "=" in part:
                    val, label = part.split("=", 1)
                    options.append({"value": int(val.strip()), "label": label.strip()})
                else:
                    options.append({"value": part, "label": part})
        else:
            kind = "text"
            options = None

        params.append(
            {
                "name": name,
                "default": default,
                "description": description.strip(),
                "kind": kind,
                "options": options,
            }
        )

    return params


def collect_profile_overrides(args, profile: str) -> dict:
    """Extract profile:varname=value overrides from request args."""
    allowed = {param["name"] for param in parse_profile_params(profile)}
    overrides = {}
    for key, value in args.items():
        name = key.removeprefix("profile:")
        if PROFILE_OVERRIDE_RE.fullmatch(key) and name in allowed and len(value) <= 128:
            overrides[key] = value
    return overrides


def parse_lonlats(raw: str) -> list[tuple[float, float]] | None:
    if not raw or len(raw) > 6000:
        return None
    points = []
    for pair in raw.split("|"):
        parts = pair.split(",")
        if len(parts) != 2:
            return None
        try:
            lon, lat = float(parts[0]), float(parts[1])
        except ValueError:
            return None
        if not isfinite(lon) or not isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
            return None
        points.append((lon, lat))
    return points if 2 <= len(points) <= MAX_ROUTE_POINTS else None


def valid_profile(profile: str) -> bool:
    return profile in PROFILES


def valid_alternative(value: str) -> bool:
    return value in {"0", "1", "2", "3"}


def rate_limit(scope: str) -> Response | None:
    now = time.monotonic()
    client = request.remote_addr or "unknown"
    key = f"{scope}:{client}"
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS[key]
        while bucket and now - bucket[0] >= RATE_LIMIT_WINDOW_S:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_REQUESTS:
            return jsonify({"error": "Too many requests; retry later"}), 429
        bucket.append(now)
        if len(_RATE_BUCKETS) > 10000:
            for old_key in [k for k, values in _RATE_BUCKETS.items() if not values or now - values[-1] >= RATE_LIMIT_WINDOW_S]:
                _RATE_BUCKETS.pop(old_key, None)
    return None


def upstream_error(exc: Exception, service: str):
    logger.warning("%s request failed: %s", service, exc)
    if isinstance(exc, requests.exceptions.Timeout):
        return jsonify({"error": f"{service} timed out"}), 504
    if isinstance(exc, requests.exceptions.ConnectionError):
        return jsonify({"error": f"{service} is unavailable"}), 503
    return jsonify({"error": f"{service} request failed"}), 502


POI_DEFS = {
    "water": {
        "label": "Water",
        "query": 'nwr["amenity"="drinking_water"]({bbox}); nwr["amenity"="water_point"]({bbox}); nwr["natural"="spring"]({bbox});',
    },
    "food": {
        "label": "Food",
        "query": 'nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub)$"]({bbox});',
    },
    "shelter": {
        "label": "Shelter",
        "query": 'nwr["amenity"="shelter"]({bbox}); nwr["tourism"~"^(wilderness_hut|alpine_hut)$"]({bbox});',
    },
}


def overpass_query_json(query: str, timeout_s: float = OVERPASS_TIMEOUT_S) -> dict:
    data = None
    last_err = None
    headers = {
        "User-Agent": "brouter-python-ui/1.0 (+https://localhost)",
        "Accept": "application/json",
    }
    for endpoint in OVERPASS_FALLBACKS:
        try:
            resp = HTTP.post(
                endpoint, data={"data": query}, headers=headers, timeout=timeout_s
            )
            resp.raise_for_status()
            data = resp.json()
            break
        except requests.exceptions.RequestException as e:
            last_err = e
            continue
    if data is None:
        raise last_err or requests.exceptions.RequestException(
            "All Overpass endpoints failed"
        )
    return data


def parse_bbox(raw: str) -> tuple[float, float, float, float] | None:
    if not raw:
        return None
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        return None
    try:
        s, w, n, e = (float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3]))
    except ValueError:
        return None
    if not all(isfinite(v) for v in (s, w, n, e)):
        return None
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        return None
    if n - s > MAX_BBOX_SPAN_DEG or e - w > MAX_BBOX_SPAN_DEG:
        return None
    return (s, w, n, e)


def poi_cache_get(key: str) -> dict | None:
    with _POI_CACHE_LOCK:
        row = _POI_CACHE.get(key)
        if not row:
            return None
        ts, payload = row
        if time.monotonic() - ts > POI_CACHE_TTL_S:
            _POI_CACHE.pop(key, None)
            return None
        return payload


def poi_cache_set(key: str, payload: dict):
    with _POI_CACHE_LOCK:
        _POI_CACHE[key] = (time.monotonic(), payload)
        if len(_POI_CACHE) <= POI_CACHE_MAX:
            return
        oldest = sorted(_POI_CACHE.items(), key=lambda kv: kv[1][0])[: len(_POI_CACHE) - POI_CACHE_MAX]
        for k, _ in oldest:
            _POI_CACHE.pop(k, None)


def build_poi_query(bbox: tuple[float, float, float, float], types: list[str]) -> str:
    s, w, n, e = bbox
    bbox_str = f"{s},{w},{n},{e}"
    blocks = []
    for t in types:
        q = POI_DEFS[t]["query"].format(bbox=bbox_str)
        blocks.append(q)
    return (
        "[out:json][timeout:30];"
        "("
        + "".join(blocks)
        + ");"
        "out center tags qt;"
    )


def categorize_poi(tags: dict) -> str | None:
    amenity = tags.get("amenity")
    natural = tags.get("natural")
    tourism = tags.get("tourism")
    if amenity in {"drinking_water", "water_point"} or natural == "spring":
        return "water"
    if amenity in {"restaurant", "cafe", "fast_food", "bar", "pub"}:
        return "food"
    if amenity == "shelter" or tourism in {"wilderness_hut", "alpine_hut"}:
        return "shelter"
    return None


def overpass_to_poi_geojson(data: dict, allowed_types: set[str]) -> dict:
    features = []
    seen = set()
    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        cat = categorize_poi(tags)
        if cat is None or cat not in allowed_types:
            continue

        lat = el.get("lat")
        lon = el.get("lon")
        center = el.get("center") or {}
        if lat is None:
            lat = center.get("lat")
        if lon is None:
            lon = center.get("lon")
        if lat is None or lon is None:
            continue

        poi_id = f"osm:{el.get('type','node')}/{el.get('id','?')}"
        if poi_id in seen:
            continue
        seen.add(poi_id)

        name = tags.get("name") or POI_DEFS.get(cat, {}).get("label", cat.title())
        features.append(
            {
                "type": "Feature",
                "id": poi_id,
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": poi_id,
                    "name": name,
                    "category": cat,
                    "tags": {
                        "amenity": tags.get("amenity"),
                        "tourism": tags.get("tourism"),
                        "natural": tags.get("natural"),
                    },
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def inject_gpx_waypoints(gpx_bytes: bytes, selected_pois: list[dict]) -> bytes:
    if not selected_pois:
        return gpx_bytes
    try:
        gpx_text = gpx_bytes.decode("utf-8")
    except UnicodeDecodeError:
        gpx_text = gpx_bytes.decode("latin-1")

    wpts = []
    for p in selected_pois:
        if not isinstance(p, dict):
            continue
        lat_raw = p.get("lat")
        lon_raw = p.get("lon")
        if lat_raw is None or lon_raw is None:
            continue
        try:
            lat = float(lat_raw)
            lon = float(lon_raw)
        except (TypeError, ValueError):
            continue
        if not isfinite(lat) or not isfinite(lon) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
            continue
        name = xml_escape(str(p.get("name") or "POI"))
        cat = xml_escape(str(p.get("category") or "poi"))
        wpts.append(
            f'<wpt lat="{lat:.6f}" lon="{lon:.6f}"><name>{name}</name><type>{cat}</type></wpt>'
        )

    if not wpts:
        return gpx_bytes

    insert = "\n" + "\n".join(wpts) + "\n"
    if "</gpx>" in gpx_text:
        gpx_text = gpx_text.replace("</gpx>", insert + "</gpx>")
    else:
        gpx_text += insert
    return gpx_text.encode("utf-8")


PAVED_SURFACES = {
    "asphalt",
    "concrete",
    "paved",
    "paving_stones",
    "sett",
    "cobblestone",
    "metal",
    "wood",
}
UNPAVED_SURFACES = {
    "gravel",
    "fine_gravel",
    "compacted",
    "pebblestone",
    "unpaved",
    "dirt",
    "ground",
    "grass",
    "mud",
    "earth",
    "grass_paver",
    "sand",
}
PAVED_HIGHWAYS = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "unclassified",
    "service",
    "living_street",
    "road",
}
UNPAVED_HIGHWAYS = {"track", "bridleway"}


def surface_category(tags: dict) -> str:
    surface = tags.get("surface")
    tracktype = tags.get("tracktype")
    highway = tags.get("highway")
    if surface:
        if surface in PAVED_SURFACES:
            return "paved"
        if surface in UNPAVED_SURFACES:
            return "unpaved"
    if tracktype and tracktype != "grade1":
        return "unpaved"
    if tracktype == "grade1":
        return "paved"
    if highway:
        if highway in PAVED_HIGHWAYS:
            return "paved"
        if highway in UNPAVED_HIGHWAYS:
            return "unpaved"
        if highway in {"cycleway", "path", "footway"}:
            return "paved"
    return "unknown"


def seg_len_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    d_lat = (lat2 - lat1) * 111320
    d_lon = (lon2 - lon1) * 111320 * cos((lat1 + lat2) / 2 * pi / 180)
    return sqrt(d_lat * d_lat + d_lon * d_lon)


def seg_heading_deg(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    dy = (lat2 - lat1) * 111320
    dx = (lon2 - lon1) * 111320 * cos((lat1 + lat2) / 2 * pi / 180)
    if dx == 0 and dy == 0:
        return 0.0
    # same frame as frontend, angle doesn't need true-bearing semantics
    return (180 / pi) * (pi / 2 - atan2(dy, dx))


def heading_diff_deg(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return min(d, 360 - d)


def point_to_segment_distance_m(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> float:
    vx = bx - ax
    vy = by - ay
    wx = px - ax
    wy = py - ay
    vv = vx * vx + vy * vy
    if vv == 0:
        dx = px - ax
        dy = py - ay
        return sqrt(dx * dx + dy * dy)
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / vv))
    cx = ax + t * vx
    cy = ay + t * vy
    dx = px - cx
    dy = py - cy
    return sqrt(dx * dx + dy * dy)


def route_bbox(coords: list) -> tuple[float, float, float, float]:
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    pad = 0.004
    return (min(lats) - pad, min(lons) - pad, max(lats) + pad, max(lons) + pad)


def fetch_osm_way_segments(coords: list) -> list[dict]:
    south, west, north, east = route_bbox(coords)
    q = f"""
[out:json][timeout:25];
(
  way["highway"]({south},{west},{north},{east});
);
out tags geom;
""".strip()

    data = None
    last_err = None
    headers = {
        "User-Agent": "brouter-python-ui/1.0 (+https://localhost)",
        "Accept": "application/json",
    }
    for endpoint in OVERPASS_FALLBACKS:
        try:
            resp = HTTP.post(
                endpoint, data={"data": q}, headers=headers, timeout=45
            )
            resp.raise_for_status()
            data = resp.json()
            break
        except requests.exceptions.RequestException as e:
            last_err = e
            continue
    if data is None:
        raise last_err or requests.exceptions.RequestException(
            "All Overpass endpoints failed"
        )

    out = []
    for el in data.get("elements", []):
        geom = el.get("geometry") or []
        tags = el.get("tags") or {}
        if len(geom) < 2:
            continue
        for i in range(1, len(geom)):
            a = geom[i - 1]
            b = geom[i]
            lon1, lat1 = a["lon"], a["lat"]
            lon2, lat2 = b["lon"], b["lat"]
            length = seg_len_m(lon1, lat1, lon2, lat2)
            if length < 2:
                continue
            mid_lat = (lat1 + lat2) / 2
            mid_lon = (lon1 + lon2) / 2
            scale = 111320 * cos(mid_lat * pi / 180)
            out.append(
                {
                    "tags": tags,
                    "heading": seg_heading_deg(lon1, lat1, lon2, lat2),
                    "mid_lat": mid_lat,
                    "mid_lon": mid_lon,
                    "ax": lon1 * scale,
                    "ay": lat1 * 111320,
                    "bx": lon2 * scale,
                    "by": lat2 * 111320,
                }
            )
    return out


def confidence_from_match(dist_m: float, hdg_diff: float) -> str:
    if dist_m <= 15 and hdg_diff <= 20:
        return "high"
    if dist_m <= 35 and hdg_diff <= 40:
        return "medium"
    return "low"


def enrich_surface_segments(coords: list) -> tuple[list[dict], float, dict]:
    if len(coords) < 2:
        return ([], 0.0, {"highPct": 0, "mediumPct": 0, "lowPct": 100})

    osm_segments = fetch_osm_way_segments(coords)
    route_segments = []
    total_m = 0.0
    for i in range(1, len(coords)):
        lon1, lat1 = coords[i - 1][0], coords[i - 1][1]
        lon2, lat2 = coords[i][0], coords[i][1]
        seg_m = seg_len_m(lon1, lat1, lon2, lat2)
        if seg_m < 1:
            continue
        route_segments.append(
            {
                "start": total_m,
                "end": total_m + seg_m,
                "mid_lat": (lat1 + lat2) / 2,
                "mid_lon": (lon1 + lon2) / 2,
                "heading": seg_heading_deg(lon1, lat1, lon2, lat2),
            }
        )
        total_m += seg_m

    enriched = []
    conf_m = {"high": 0.0, "medium": 0.0, "low": 0.0}
    for rs in route_segments:
        scale = 111320 * cos(rs["mid_lat"] * pi / 180)
        px = rs["mid_lon"] * scale
        py = rs["mid_lat"] * 111320
        best = None
        best_score = float("inf")

        for osm_segment in osm_segments:
            if (
                abs(osm_segment["mid_lat"] - rs["mid_lat"]) > 0.0008
                or abs(osm_segment["mid_lon"] - rs["mid_lon"]) > 0.0012
            ):
                continue
            dist_m = point_to_segment_distance_m(
                px,
                py,
                osm_segment["ax"],
                osm_segment["ay"],
                osm_segment["bx"],
                osm_segment["by"],
            )
            if dist_m > 65:
                continue
            hd = heading_diff_deg(rs["heading"], osm_segment["heading"])
            if hd > 80:
                continue
            score = dist_m + 0.4 * hd
            if score < best_score:
                best_score = score
                best = (osm_segment, dist_m, hd)

        if best is None:
            seg_len = rs["end"] - rs["start"]
            conf_m["low"] += max(0.0, seg_len)
            enriched.append(
                {
                    "dist_start_m": rs["start"],
                    "dist_end_m": rs["end"],
                    "category": "unknown",
                    "confidence": "low",
                }
            )
            continue

        osm_segment, dist_m, hd = best
        conf = confidence_from_match(dist_m, hd)
        seg_len = rs["end"] - rs["start"]
        conf_m[conf] += max(0.0, seg_len)
        enriched.append(
            {
                "dist_start_m": rs["start"],
                "dist_end_m": rs["end"],
                "category": surface_category(osm_segment["tags"]),
                "confidence": conf,
            }
        )

    if not enriched:
        return ([], total_m, {"highPct": 0, "mediumPct": 0, "lowPct": 100})

    merged = [enriched[0]]
    for seg in enriched[1:]:
        cur = merged[-1]
        if (
            seg["category"] == cur["category"]
            and seg["confidence"] == cur["confidence"]
        ):
            cur["dist_end_m"] = seg["dist_end_m"]
        else:
            merged.append(seg)
    denom = total_m if total_m > 0 else 1
    conf_stats = {
        "highPct": round(conf_m["high"] / denom * 100),
        "mediumPct": round(conf_m["medium"] / denom * 100),
        "lowPct": round(conf_m["low"] / denom * 100),
    }
    return (merged, total_m, conf_stats)


def unknown_surface_fallback(coords: list, warning: str | None = None) -> dict:
    total = 0.0
    for i in range(1, len(coords)):
        total += seg_len_m(
            coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]
        )
    return {
        "surface_segments": [
            {
                "dist_start_m": 0,
                "dist_end_m": total,
                "category": "unknown",
                "confidence": "low",
            }
        ]
        if total > 0
        else [],
        "track_length_m": round(total),
        "surface_stats": {"highPct": 0, "mediumPct": 0, "lowPct": 100},
        "warning": warning,
    }


@app.route("/")
def index():
    return render_template("index.html", profiles=PROFILES)


@app.route("/profile-params/<profile>")
def profile_params(profile):
    """Return parsed configurable parameters for a profile as JSON."""
    if profile not in PROFILES:
        return jsonify({"error": "Unknown profile"}), 404
    params = parse_profile_params(profile)
    return jsonify(params)


@app.route("/route")
def route():
    """Proxy the BRouter API, always returning GeoJSON for map display."""
    lonlats = request.args.get("lonlats")
    profile = request.args.get("profile", "trekking")
    alternativeidx = request.args.get("alternativeidx", "0")
    limited = rate_limit("route")
    if limited:
        return limited

    if not parse_lonlats(lonlats or ""):
        return jsonify({"error": "lonlats must contain 2-100 valid lon,lat points"}), 400
    if not valid_profile(profile):
        return jsonify({"error": "Unknown profile"}), 400
    if not valid_alternative(alternativeidx):
        return jsonify({"error": "alternativeidx must be 0, 1, 2, or 3"}), 400

    params = {
        "lonlats": lonlats,
        "profile": profile,
        "alternativeidx": alternativeidx,
        "format": "geojson",
        **collect_profile_overrides(request.args, profile),
    }

    try:
        resp = HTTP.get(BROUTER_URL, params=params, timeout=BROUTER_TIMEOUT_S)
        resp.raise_for_status()
        return Response(resp.content, status=200, mimetype="application/geo+json")
    except requests.exceptions.RequestException as e:
        return upstream_error(e, "BRouter")
    except Exception:
        logger.exception("Unexpected route proxy failure")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/download")
def download():
    """Proxy BRouter and return the route in the requested format for download."""
    lonlats = request.args.get("lonlats")
    profile = request.args.get("profile", "trekking")
    fmt = request.args.get("format", "gpx")
    trackname = request.args.get("trackname", "brouter")
    alternativeidx = request.args.get("alternativeidx", "0")
    selected_pois_raw = request.args.get("selected_pois", "")
    limited = rate_limit("download")
    if limited:
        return limited

    if not parse_lonlats(lonlats or ""):
        return jsonify({"error": "lonlats must contain 2-100 valid lon,lat points"}), 400
    if not valid_profile(profile):
        return jsonify({"error": "Unknown profile"}), 400
    if not valid_alternative(alternativeidx):
        return jsonify({"error": "alternativeidx must be 0, 1, 2, or 3"}), 400
    if fmt not in DOWNLOAD_FORMATS:
        return jsonify({"error": "Unsupported download format"}), 400
    if len(trackname) > MAX_TRACK_NAME_LEN:
        return jsonify({"error": "Track name is too long"}), 400
    safe_trackname = secure_filename(trackname)[:MAX_TRACK_NAME_LEN] or "brouter"
    if len(selected_pois_raw) > 100000:
        return jsonify({"error": "Too many selected POIs"}), 400

    params = {
        "lonlats": lonlats,
        "profile": profile,
        "format": fmt,
        "trackname": safe_trackname,
        "alternativeidx": alternativeidx,
        **collect_profile_overrides(request.args, profile),
    }

    try:
        resp = HTTP.get(BROUTER_URL, params=params, timeout=BROUTER_TIMEOUT_S)
        resp.raise_for_status()
        out_content = resp.content

        if fmt == "gpx" and selected_pois_raw:
            try:
                selected_pois = json.loads(selected_pois_raw)
                if isinstance(selected_pois, list) and len(selected_pois) <= 500:
                    out_content = inject_gpx_waypoints(resp.content, selected_pois)
                else:
                    return jsonify({"error": "selected_pois must be a list of at most 500 items"}), 400
            except (TypeError, ValueError, json.JSONDecodeError):
                return jsonify({"error": "selected_pois is invalid JSON"}), 400

        mime, ext = DOWNLOAD_FORMATS[fmt]
        filename = f"{safe_trackname}.{ext}"
        return Response(
            out_content,
            status=200,
            mimetype=mime,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except requests.exceptions.RequestException as e:
        return upstream_error(e, "BRouter")
    except Exception:
        logger.exception("Unexpected download proxy failure")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/surface-enrich", methods=["POST"])
def surface_enrich():
    """Infer paved/unpaved categories for imported GPX geometry via Overpass matching."""
    body = request.get_json(silent=True) or {}
    limited = rate_limit("surface-enrich")
    if limited:
        return limited
    features = body.get("features")
    if not isinstance(features, list) or not features or not isinstance(features[0], dict):
        return jsonify({"error": "Expected a GeoJSON FeatureCollection"}), 400
    feature = features[0]
    geom = feature.get("geometry") or {}
    coords = geom.get("coordinates") or []
    if geom.get("type") != "LineString" or not isinstance(coords, list) or not 2 <= len(coords) <= MAX_ENRICH_POINTS:
        return jsonify({"error": "Expected GeoJSON LineString coordinates"}), 400
    validated = []
    for coord in coords:
        if not isinstance(coord, list) or len(coord) < 2:
            return jsonify({"error": "Invalid route coordinate"}), 400
        try:
            lon, lat = float(coord[0]), float(coord[1])
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid route coordinate"}), 400
        if not isfinite(lon) or not isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
            return jsonify({"error": "Invalid route coordinate"}), 400
        validated.append([lon, lat])
    coords = validated
    south, west, north, east = route_bbox(coords)
    if north - south > MAX_BBOX_SPAN_DEG or east - west > MAX_BBOX_SPAN_DEG:
        return jsonify({"error": "Route extent is too large for surface enrichment"}), 400

    try:
        surface_segments, total_m, conf_stats = enrich_surface_segments(coords)
    except requests.exceptions.RequestException as e:
        payload = unknown_surface_fallback(
            coords,
            warning=f"Surface enrichment unavailable ({e.__class__.__name__}); using unknown surface.",
        )
        return jsonify(payload)
    except Exception as e:  # noqa: BLE001
        payload = unknown_surface_fallback(
            coords,
            warning=f"Surface enrichment failed ({e.__class__.__name__}); using unknown surface.",
        )
        return jsonify(payload)

    return jsonify(
        {
            "surface_segments": surface_segments,
            "track_length_m": round(total_m),
            "surface_stats": conf_stats,
        }
    )


@app.route("/pois")
def pois():
    limited = rate_limit("pois")
    if limited:
        return limited
    bbox_raw = request.args.get("bbox", "")
    zoom_raw = request.args.get("zoom", "0")
    types_raw = request.args.get("types", "water,food,shelter")

    bbox = parse_bbox(bbox_raw)
    if not bbox:
        return jsonify({"error": "bbox must be a bounded south,west,north,east area"}), 400

    try:
        zoom = int(zoom_raw)
    except ValueError:
        zoom = 0

    req_types = [t.strip() for t in types_raw.split(",") if t.strip()]
    req_types = [t for t in req_types if t in POI_DEFS]
    if not req_types:
        return jsonify({"type": "FeatureCollection", "features": [], "zoom_blocked": False})

    if zoom < POI_MIN_ZOOM:
        return jsonify(
            {
                "type": "FeatureCollection",
                "features": [],
                "zoom_blocked": True,
                "min_zoom": POI_MIN_ZOOM,
            }
        )

    normalized_bbox = (
        round(bbox[0], 5),
        round(bbox[1], 5),
        round(bbox[2], 5),
        round(bbox[3], 5),
    )
    cache_key = f"{','.join(map(str, normalized_bbox))}|{','.join(sorted(req_types))}|z{zoom}"
    cached = poi_cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    query = build_poi_query(normalized_bbox, req_types)
    try:
        data = overpass_query_json(query)
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"POI request failed: {e.__class__.__name__}"}), 503

    payload = overpass_to_poi_geojson(data, set(req_types))
    payload["zoom_blocked"] = False
    payload["min_zoom"] = POI_MIN_ZOOM
    poi_cache_set(cache_key, payload)
    return jsonify(payload)


if __name__ == "__main__":
    app.run(debug=os.getenv("FLASK_DEBUG", "0") == "1", port=int(os.getenv("PORT", "5000")))
