"""Table extraction must report cell text, never pdfplumber bbox tuples."""

import re
import sys
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402

BBOX_LIKE = re.compile(r"^\(?-?\d+(\.\d+)?,\s*-?\d+")


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
