from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_external_values_are_not_interpolated_into_html():
    geocoder = (ROOT / "static/js/geocoder.js").read_text()
    main = (ROOT / "static/js/main.js").read_text()

    assert "item.innerHTML" not in geocoder
    assert "div.innerHTML" not in geocoder
    assert "${poi.name}" not in main
    assert "${p.description}" not in main
    assert "${p.name}" not in main


def test_release_two_guards_and_import_preservation_are_present():
    route = (ROOT / "static/js/route.js").read_text()
    main = (ROOT / "static/js/main.js").read_text()
    gpx = (ROOT / "static/js/gpx.js").read_text()

    assert "AbortController" in route
    assert "state.routeRequestSeq" in route
    assert "state.poiRequestSeq" in main
    assert "state.profileParamsRequestSeq" in main
    assert "URL.createObjectURL" in main
    assert "MultiLineString" in gpx
    assert "file exceeds 2 MB" in main
