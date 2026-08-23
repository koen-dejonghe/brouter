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
