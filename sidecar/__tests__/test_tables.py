"""Table extraction must report cell text, never pdfplumber bbox tuples."""

import json
import re
import sys
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402

BBOX_LIKE = re.compile(r"^\(?-?\d+(\.\d+)?,\s*-?\d+")


def _write_pdf(path: Path, objects: list[bytes]) -> str:
    """Write a minimal PDF with numbered objects (1-based, no compression)."""
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref_position = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref_position,
    )
    path.write_bytes(bytes(out))
    return str(path)


@pytest.fixture()
def ruled_table_pdf(tmp_path):
    """One page with a 2x2 ruled grid; the bottom-left cell is left empty."""
    path = tmp_path / "table.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.rect(50, 650, 300, 80)
    c.line(200, 650, 200, 730)
    c.line(50, 690, 350, 690)
    c.setFont("Helvetica", 10)
    c.drawString(60, 700, "Header A")
    c.drawString(210, 700, "Header B")
    c.drawString(210, 660, "Row B1")
    c.showPage()
    c.save()
    return str(path)


def test_table_cells_contain_text(ruled_table_pdf):
    page = PdfExtractor(ruled_table_pdf).extract_page(1)

    assert len(page["tables"]) == 1
    table = page["tables"][0]
    assert table["cells"] == [["Header A", "Header B"], ["", "Row B1"]]
    assert table["rows"] == 2
    assert table["cols"] == 2


def test_table_cells_are_strings_not_bboxes(ruled_table_pdf):
    table = PdfExtractor(ruled_table_pdf).extract_page(1)["tables"][0]

    for row in table["cells"]:
        for cell in row:
            assert isinstance(cell, str)
            assert not BBOX_LIKE.match(cell), f"cell looks like a bbox tuple: {cell!r}"


def test_table_geometry_and_metadata_fields_preserved(ruled_table_pdf):
    table = PdfExtractor(ruled_table_pdf).extract_page(1)["tables"][0]

    assert table["type"] == "table"
    assert table["page"] == 1
    assert table["x1"] > table["x0"]
    assert table["y1"] > table["y0"]
    for field in ("x0", "y0", "x1", "y1"):
        assert isinstance(table[field], float)
    # rows/cols must agree with the returned cell matrix.
    assert table["rows"] == len(table["cells"])
    assert table["cols"] == max(len(row) for row in table["cells"])
    # The new optional fields never change the old ones.
    assert table["rows"] == len(table["cellBoxes"]) == len(table["cellSpans"])
    for row in table["cellBoxes"]:
        assert len(row) == table["cols"]
    for row in table["cellSpans"]:
        assert len(row) == table["cols"]
    json.dumps(table)


# --- cell geometry ---------------------------------------------------------


@pytest.fixture()
def merged_cell_pdf(tmp_path):
    """Top row is a single cell spanning both columns (its divider starts below)."""
    path = tmp_path / "merged.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.rect(50, 650, 300, 80)
    c.line(200, 650, 200, 690)  # vertical rule only in the bottom row
    c.line(50, 690, 350, 690)
    c.setFont("Helvetica", 10)
    c.drawString(60, 700, "SpanHeader")
    c.drawString(60, 660, "A1")
    c.drawString(210, 660, "B1")
    c.showPage()
    c.save()
    return str(path)


@pytest.fixture()
def offset_mediabox_table_pdf(tmp_path):
    """Same 2x2 grid, but the MediaBox does not start at y = 0.

    pdfminer translates the page content by the MediaBox origin, so this is the
    regression case for a conversion that forgets ``mediabox_top``.
    """
    content = (
        b"50 650 300 80 re S\n"
        b"200 650 m 200 730 l S\n"
        b"50 690 m 350 690 l S\n"
        b"BT /F1 10 Tf 60 700 Td (Header A) Tj ET\n"
        b"BT /F1 10 Tf 210 700 Td (Header B) Tj ET\n"
        b"BT /F1 10 Tf 210 660 Td (Row B1) Tj ET\n"
    )
    return _write_pdf(tmp_path / "offset.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 100 612 892]"
        b" /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ])


def _extract(path: str) -> dict:
    extractor = PdfExtractor(path)
    try:
        return extractor.extract_page(1)
    finally:
        extractor.close()


def _contains(box: dict, obj: dict, tolerance: float = 0.5) -> bool:
    """True when ``obj``'s centre lies inside ``box`` (both bottom-left PDF space)."""
    cx = (obj["x0"] + obj["x1"]) / 2
    cy = (obj["y0"] + obj["y1"]) / 2
    return (
        box["x0"] - tolerance <= cx <= box["x1"] + tolerance
        and box["y0"] - tolerance <= cy <= box["y1"] + tolerance
    )


def _assert_words_land_in_their_cells(page: dict, table: dict) -> None:
    """Every word inside the table sits in the cell whose text lists it."""
    for word in page["words"]:
        matches = [
            (row, col)
            for row in range(table["rows"])
            for col in range(table["cols"])
            if table["cellBoxes"][row][col] is not None
            and _contains(table["cellBoxes"][row][col], word)
        ]
        assert len(matches) == 1, f"{word['text']!r} matches cells {matches}"
        row, col = matches[0]
        assert word["text"] in table["cells"][row][col].split(), (
            f"{word['text']!r} landed in cell ({row}, {col}) "
            f"holding {table['cells'][row][col]!r}"
        )
        assert _contains(table, word), "a cell can never leave the table box"


def test_table_bbox_matches_the_drawn_grid(ruled_table_pdf):
    """The table box must use the same bottom-left frame as rects/chars."""
    page = _extract(ruled_table_pdf)
    table = page["tables"][0]
    grid = page["rects"][0]

    assert table["x0"] == pytest.approx(grid["x0"])
    assert table["y0"] == pytest.approx(grid["y0"])
    assert table["x1"] == pytest.approx(grid["x1"])
    assert table["y1"] == pytest.approx(grid["y1"])


def test_cell_boxes_contain_the_cell_text(ruled_table_pdf):
    page = _extract(ruled_table_pdf)
    table = page["tables"][0]

    _assert_words_land_in_their_cells(page, table)

    # The empty cell keeps a box (it exists in the grid) but holds no text.
    empty = table["cellBoxes"][1][0]
    assert empty is not None
    assert table["cells"][1][0] == ""
    assert table["cellSpans"][1][0] == {"rowSpan": 1, "colSpan": 1}


def test_cell_boxes_align_on_an_offset_mediabox(offset_mediabox_table_pdf):
    page = _extract(offset_mediabox_table_pdf)
    table = page["tables"][0]
    grid = page["rects"][0]

    assert page["boxes"]["media"]["y0"] == 100.0
    assert table["x0"] == pytest.approx(grid["x0"])
    assert table["y0"] == pytest.approx(grid["y0"])
    assert table["x1"] == pytest.approx(grid["x1"])
    assert table["y1"] == pytest.approx(grid["y1"])
    _assert_words_land_in_their_cells(page, table)


def test_merged_cell_is_covered_without_shifting_the_text(merged_cell_pdf):
    page = _extract(merged_cell_pdf)
    table = page["tables"][0]

    # Old fields are untouched by the geometry work.
    assert table["cells"] == [["SpanHeader", ""], ["A1", "B1"]]
    assert table["rows"] == 2
    assert table["cols"] == 2

    # The spanning cell keeps its box on the top-left anchor only.
    merged = table["cellBoxes"][0][0]
    assert merged is not None
    assert table["cellBoxes"][0][1] is None
    assert table["cellSpans"][0][0] == {"rowSpan": 1, "colSpan": 2}
    assert table["cellSpans"][0][1] is None
    assert merged["x0"] == pytest.approx(table["x0"])
    assert merged["x1"] == pytest.approx(table["x1"])

    # The second row is unaffected: one box per column, no invented span.
    assert table["cellBoxes"][1][0]["x1"] == pytest.approx(200.0)
    assert table["cellBoxes"][1][1]["x0"] == pytest.approx(200.0)
    assert table["cellSpans"][1][0] == {"rowSpan": 1, "colSpan": 1}
    assert table["cellSpans"][1][1] == {"rowSpan": 1, "colSpan": 1}

    _assert_words_land_in_their_cells(page, table)


@pytest.mark.parametrize("mediabox_top", [0.0, 100.0, -50.0])
def test_table_bbox_conversion_inverts_pdfplumber_top_left(mediabox_top):
    page_height = 792.0
    top, bottom = 62.0, 142.0

    box = PdfExtractor._table_bbox_to_pdf((50, top, 350, bottom), page_height, mediabox_top)

    assert box["x0"] == 50.0
    assert box["x1"] == 350.0
    assert box["y0"] == pytest.approx(page_height + mediabox_top - bottom)
    assert box["y1"] == pytest.approx(page_height + mediabox_top - top)
    assert PdfExtractor._cell_bbox_to_pdf(None, page_height, mediabox_top) is None


class _FakeRow:
    def __init__(self, cells):
        self.cells = cells


class _FakeTable:
    def __init__(self, rows, bbox):
        self.rows = [_FakeRow(cells) for cells in rows]
        self.bbox = bbox


def test_ragged_cell_grid_is_padded_with_nulls():
    """A short row (or a spanning cell) must never shift the text matrix."""
    table = _FakeTable(
        rows=[[(50, 62, 350, 102)], [(50, 102, 200, 142), (200, 102, 350, 142)]],
        bbox=(50, 62, 350, 142),
    )

    cell_boxes, cell_spans = PdfExtractor._table_cell_geometry(
        table, [["span"], ["A1", "B1"]], 792.0, 0.0
    )

    assert len(cell_boxes) == len(cell_spans) == 2
    assert all(len(row) == 2 for row in cell_boxes)
    # Row 0 only has one cell in pdfplumber's grid; the second column is null.
    assert cell_boxes[0][1] is None
    assert cell_spans[0][0] == {"rowSpan": 1, "colSpan": 2}
    # Row 1 is untouched and still has one box per column.
    assert cell_boxes[1][0]["x1"] == pytest.approx(200.0)
    assert cell_boxes[1][1]["x0"] == pytest.approx(200.0)
    assert cell_spans[1][0] == {"rowSpan": 1, "colSpan": 1}
    assert cell_spans[1][1] == {"rowSpan": 1, "colSpan": 1}
