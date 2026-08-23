from unittest.mock import Mock

import pytest
import requests

import app as application


@pytest.fixture(autouse=True)
def reset_state():
    application._RATE_BUCKETS.clear()
    application._POI_CACHE.clear()


@pytest.fixture
def client():
    application.app.config.update(TESTING=True)
    return application.app.test_client()


@pytest.mark.parametrize(
    "lonlats",
    ["", "1,2", "181,2|1,2", "nan,2|1,2", "1,91|1,2", "bad|1,2"],
)
def test_route_rejects_invalid_coordinates(client, lonlats):
    response = client.get("/route", query_string={"lonlats": lonlats})
    assert response.status_code == 400


def test_route_rejects_unknown_profile(client):
    response = client.get(
        "/route",
        query_string={"lonlats": "1,2|2,3", "profile": "../../secret"},
    )
    assert response.status_code == 400


def test_route_does_not_forward_unknown_overrides(client, monkeypatch):
    upstream = Mock(content=b'{"type":"FeatureCollection"}')
    upstream.raise_for_status.return_value = None
    get = Mock(return_value=upstream)
    monkeypatch.setattr(application.HTTP, "get", get)
    monkeypatch.setattr(
        application,
        "parse_profile_params",
        lambda profile: [{"name": "allowed"}],
    )

    response = client.get(
        "/route",
        query_string={
            "lonlats": "1,2|2,3",
            "profile:allowed": "1",
            "profile:unknown": "1",
        },
    )

    assert response.status_code == 200
    params = get.call_args.kwargs["params"]
    assert params["profile:allowed"] == "1"
    assert "profile:unknown" not in params


def test_route_maps_upstream_timeout(client, monkeypatch):
    monkeypatch.setattr(
        application.HTTP,
        "get",
        Mock(side_effect=requests.exceptions.Timeout("details must not leak")),
    )
    response = client.get("/route", query_string={"lonlats": "1,2|2,3"})
    assert response.status_code == 504
    assert response.get_json() == {"error": "BRouter timed out"}


def test_download_rejects_format_and_sanitizes_filename(client, monkeypatch):
    bad = client.get(
        "/download",
        query_string={"lonlats": "1,2|2,3", "format": "html"},
    )
    assert bad.status_code == 400

    upstream = Mock(content=b"<gpx></gpx>")
    upstream.raise_for_status.return_value = None
    monkeypatch.setattr(application.HTTP, "get", Mock(return_value=upstream))
    good = client.get(
        "/download",
        query_string={"lonlats": "1,2|2,3", "trackname": '../../bad"name'},
    )
    assert good.status_code == 200
    assert "badname.gpx" in good.headers["Content-Disposition"]


def test_download_rejects_invalid_selected_pois(client, monkeypatch):
    upstream = Mock(content=b"<gpx></gpx>")
    upstream.raise_for_status.return_value = None
    monkeypatch.setattr(application.HTTP, "get", Mock(return_value=upstream))
    response = client.get(
        "/download",
        query_string={"lonlats": "1,2|2,3", "selected_pois": "not-json"},
    )
    assert response.status_code == 400


def test_pois_rejects_large_or_nonfinite_bbox(client):
    assert client.get("/pois?bbox=0,0,3,3&zoom=12").status_code == 400
    assert client.get("/pois?bbox=0,0,nan,1&zoom=12").status_code == 400


def test_surface_enrich_validates_structure_and_extent(client):
    malformed = client.post("/surface-enrich", json={"features": {}})
    assert malformed.status_code == 400

    large = client.post(
        "/surface-enrich",
        json={
            "features": [
                {"geometry": {"type": "LineString", "coordinates": [[0, 0], [3, 3]]}}
            ]
        },
    )
    assert large.status_code == 400


def test_gpx_waypoints_skip_invalid_coordinates():
    pois = [
        {"lat": "nan", "lon": 1, "name": "bad"},
        {"lat": 2, "lon": 3, "name": "A&B", "category": "water"},
    ]
    output = application.inject_gpx_waypoints(b"<gpx></gpx>", pois).decode()
    assert "bad" not in output
    assert "A&amp;B" in output
    assert output.count("<wpt ") == 1


def test_rate_limit_is_applied(client, monkeypatch):
    monkeypatch.setattr(application, "RATE_LIMIT_REQUESTS", 1)
    first = client.get("/pois?bbox=0,0,1,1&zoom=1")
    second = client.get("/pois?bbox=0,0,1,1&zoom=1")
    assert first.status_code == 200
    assert second.status_code == 429


def test_surface_category_does_not_guess_unspecified_paths_are_paved():
    assert application.surface_category({"highway": "path"}) == "unknown"
    assert application.surface_category({"highway": "cycleway"}) == "unknown"
    assert application.surface_category({"tracktype": "grade1"}) == "unknown"
    assert application.surface_category({"surface": "asphalt"}) == "paved"


def test_opposite_way_direction_is_accepted(monkeypatch):
    monkeypatch.setattr(
        application,
        "fetch_osm_way_segments",
        lambda coords: [
            {
                "tags": {"surface": "asphalt"},
                "heading": -90.0,
                "mid_lat": 0.0,
                "mid_lon": 0.0005,
                "ax": 111.32,
                "ay": 0.0,
                "bx": 0.0,
                "by": 0.0,
                "origin_lat": 0.0,
                "origin_lon": 0.0,
                "lon_scale": 111320.0,
            }
        ],
    )
    segments, _, _ = application.enrich_surface_segments([[0.0, 0.0], [0.001, 0.0]])
    assert segments[0]["category"] == "paved"


def test_health_endpoints(client, monkeypatch, tmp_path):
    assert client.get("/health/live").get_json() == {"status": "ok"}
    monkeypatch.setattr(application, "PROFILES_DIR", tmp_path)
    assert client.get("/health/ready").status_code == 200
    monkeypatch.setattr(application, "PROFILES_DIR", tmp_path / "missing")
    assert client.get("/health/ready").status_code == 503
