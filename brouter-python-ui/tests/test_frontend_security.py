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
    assert "maxGpxFileSize" in main


def test_release_three_structure_and_accessibility():
    geometry = (ROOT / "static/js/geometry.js").read_text()
    gpx = (ROOT / "static/js/gpx.js").read_text()
    template = (ROOT / "templates/index.html").read_text()
    css = (ROOT / "static/css/sidebar.css").read_text()

    assert "segmentDistanceMeters" in geometry
    assert "from './geometry.js'" in gpx
    assert 'role="combobox"' in template
    assert 'role="status"' in template
    assert 'aria-controls="waypoint-list"' in template
    assert "@media (max-width: 760px)" in css
    assert ":focus-visible" in css


def test_imported_surface_uses_brouter_with_geometry_fallback():
    main = (ROOT / "static/js/main.js").read_text()
    assert "enrichImportedSurfaceViaBrouter" in main
    assert "surfaceSegmentsFromBrouterMessages" in main
    assert "enrichImportedSurfaceViaOverpass" in main


def test_grade_extremes_use_robust_sustained_windows():
    geometry = (ROOT / "static/js/geometry.js").read_text()
    stats = (ROOT / "static/js/stats.js").read_text()
    elevation = (ROOT / "static/js/elevation.js").read_text()
    assert "sustainedGradeExtremes" in geometry
    assert "quantile(grades, 0.95)" in geometry
    assert "sustainedGradeExtremes" in stats
    assert "sustainedGradeExtremes" in elevation
