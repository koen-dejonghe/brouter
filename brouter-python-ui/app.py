from flask import Flask, render_template, request, jsonify, Response
import requests
import re
from pathlib import Path
from math import atan2, cos, pi, sqrt

app = Flask(__name__)

BROUTER_URL = "http://localhost:17777/brouter"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_FALLBACKS = [
    OVERPASS_URL,
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
PROFILES_DIR = Path(__file__).parent.parent / "misc" / "profiles2"

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


def collect_profile_overrides(args) -> dict:
    """Extract profile:varname=value overrides from request args."""
    overrides = {}
    for key, value in args.items():
        if key.startswith("profile:"):
            overrides[key] = value
    return overrides


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
            resp = requests.post(
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

        for os in osm_segments:
            if (
                abs(os["mid_lat"] - rs["mid_lat"]) > 0.0008
                or abs(os["mid_lon"] - rs["mid_lon"]) > 0.0012
            ):
                continue
            dist_m = point_to_segment_distance_m(
                px, py, os["ax"], os["ay"], os["bx"], os["by"]
            )
            if dist_m > 65:
                continue
            hd = heading_diff_deg(rs["heading"], os["heading"])
            if hd > 80:
                continue
            score = dist_m + 0.4 * hd
            if score < best_score:
                best_score = score
                best = (os, dist_m, hd)

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

        os, dist_m, hd = best
        conf = confidence_from_match(dist_m, hd)
        seg_len = rs["end"] - rs["start"]
        conf_m[conf] += max(0.0, seg_len)
        enriched.append(
            {
                "dist_start_m": rs["start"],
                "dist_end_m": rs["end"],
                "category": surface_category(os["tags"]),
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

    if not lonlats:
        return jsonify({"error": "lonlats parameter is required"}), 400

    params = {
        "lonlats": lonlats,
        "profile": profile,
        "alternativeidx": alternativeidx,
        "format": "geojson",
        **collect_profile_overrides(request.args),
    }

    try:
        resp = requests.get(BROUTER_URL, params=params, timeout=60)
        resp.raise_for_status()
        return Response(resp.content, status=200, mimetype="application/geo+json")
    except requests.exceptions.ConnectionError:
        return jsonify(
            {"error": "Cannot connect to BRouter on localhost:17777. Is it running?"}
        ), 503
    except requests.exceptions.HTTPError:
        return jsonify({"error": resp.text}), resp.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/download")
def download():
    """Proxy BRouter and return the route in the requested format for download."""
    lonlats = request.args.get("lonlats")
    profile = request.args.get("profile", "trekking")
    fmt = request.args.get("format", "gpx")
    trackname = request.args.get("trackname", "brouter")
    alternativeidx = request.args.get("alternativeidx", "0")

    if not lonlats:
        return jsonify({"error": "lonlats parameter is required"}), 400

    params = {
        "lonlats": lonlats,
        "profile": profile,
        "format": fmt,
        "trackname": trackname,
        "alternativeidx": alternativeidx,
        **collect_profile_overrides(request.args),
    }

    mime_types = {
        "gpx": "application/gpx+xml",
        "kml": "application/vnd.google-earth.kml+xml",
        "geojson": "application/geo+json",
        "csv": "text/tab-separated-values",
    }
    extensions = {"gpx": "gpx", "kml": "kml", "geojson": "geojson", "csv": "csv"}

    try:
        resp = requests.get(BROUTER_URL, params=params, timeout=60)
        resp.raise_for_status()
        mime = mime_types.get(fmt, "application/octet-stream")
        ext = extensions.get(fmt, fmt)
        filename = f"{trackname}.{ext}"
        return Response(
            resp.content,
            status=200,
            mimetype=mime,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except requests.exceptions.ConnectionError:
        return jsonify(
            {"error": "Cannot connect to BRouter on localhost:17777. Is it running?"}
        ), 503
    except requests.exceptions.HTTPError:
        return jsonify({"error": resp.text}), resp.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/surface-enrich", methods=["POST"])
def surface_enrich():
    """Infer paved/unpaved categories for imported GPX geometry via Overpass matching."""
    body = request.get_json(silent=True) or {}
    feature = (body.get("features") or [{}])[0]
    geom = feature.get("geometry") or {}
    coords = geom.get("coordinates") or []
    if geom.get("type") != "LineString" or len(coords) < 2:
        return jsonify({"error": "Expected GeoJSON LineString coordinates"}), 400

    try:
        surface_segments, total_m, conf_stats = enrich_surface_segments(coords)
    except requests.exceptions.RequestException as e:
        payload = unknown_surface_fallback(
            coords,
            warning=f"Surface enrichment unavailable ({e.__class__.__name__}); using unknown surface.",
        )
        return jsonify(payload)
    except Exception as e:
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


if __name__ == "__main__":
    app.run(debug=True, port=5000)
