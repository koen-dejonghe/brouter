from flask import Flask, render_template, request, jsonify, Response
import requests
import re
from pathlib import Path

app = Flask(__name__)

BROUTER_URL = "http://localhost:17777/brouter"
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


if __name__ == "__main__":
    app.run(debug=True, port=5000)
