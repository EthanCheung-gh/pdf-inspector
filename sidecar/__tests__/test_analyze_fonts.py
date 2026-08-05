import sys
from pathlib import Path

import pytest
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.pagesizes import letter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402


@pytest.fixture()
def multi_font_pdf(tmp_path):
    """Two pages: page 1 uses Helvetica at 10 and 14pt, page 2 uses Courier at 12pt."""
    path = tmp_path / "fonts.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.setFont("Helvetica", 10)
    c.drawString(50, 700, "alpha")
    c.setFont("Helvetica", 14)
    c.drawString(50, 650, "beta")
    c.showPage()
    c.setFont("Courier", 12)
    c.drawString(50, 700, "gamma")
    c.save()
    return str(path)


@pytest.fixture()
def empty_pdf(tmp_path):
    path = tmp_path / "empty.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.showPage()
    c.save()
    return str(path)


def test_aggregates_pages_and_char_counts(multi_font_pdf):
    result = PdfExtractor(multi_font_pdf).analyze_fonts()
    fonts = {f["fontname"]: f for f in result["fonts"]}
    assert "Helvetica" in fonts
    assert fonts["Helvetica"]["pages"] == [1]
    assert fonts["Helvetica"]["charCount"] == 9  # "alpha"(5) + "beta"(4)
    assert fonts["Helvetica"]["sizeMin"] == 10
    assert fonts["Helvetica"]["sizeMax"] == 14
    assert "Courier" in fonts
    assert fonts["Courier"]["pages"] == [2]
    assert fonts["Courier"]["charCount"] == 5  # "gamma"


def test_sorted_by_char_count_descending(multi_font_pdf):
    result = PdfExtractor(multi_font_pdf).analyze_fonts()
    counts = [f["charCount"] for f in result["fonts"]]
    assert counts == sorted(counts, reverse=True)


def test_colors_deduplicated(multi_font_pdf):
    result = PdfExtractor(multi_font_pdf).analyze_fonts()
    helvetica = next(f for f in result["fonts"] if f["fontname"] == "Helvetica")
    assert helvetica["colors"] == sorted(set(helvetica["colors"]))


def test_empty_document_returns_empty_fonts(empty_pdf):
    result = PdfExtractor(empty_pdf).analyze_fonts()
    assert result["fonts"] == []
