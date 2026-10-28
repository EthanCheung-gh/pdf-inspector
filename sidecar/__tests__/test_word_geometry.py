"""Word bboxes must land on the same coordinates as chars for any MediaBox origin.

pdfplumber's WordExtractor only exposes top/bottom, which it builds from the char
boxes as::

    top    = page.height - y1 + mediabox_top
    bottom = page.height - y0 + mediabox_top

so the inverse used by the extractor must add the MediaBox vertical origin back.
Dropping it (or treating it as 0) displaces words by |mediabox_top| points.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402


def _pdfplumber_word_box(y0, y1, page_height, mediabox_top):
    """Mirror pdfplumber's forward char -> word conversion for one glyph box."""
    return {
        "x0": 72.0,
        "x1": 140.0,
        "top": (page_height - y1) + mediabox_top,
        "bottom": (page_height - y0) + mediabox_top,
        "text": "glyph",
    }


def _text_pdf(path: Path, mediabox: bytes, text: str, baseline: int) -> str:
    """Hand-write a one-page PDF with the given MediaBox and a single text run."""
    content = b"BT /F1 12 Tf 72 %d Td (%s) Tj ET" % (baseline, text.encode("ascii"))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox " + mediabox
        + b" /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % index + body + b"\nendobj\n"
    xref_offset = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref_offset,
    )
    path.write_bytes(bytes(out))
    return str(path)


@pytest.mark.parametrize("mediabox_top", [0, -100])
def test_derived_word_range_equals_pdfplumber_char_coords(mediabox_top):
    page_height = 792.0
    char_y0, char_y1 = 517.516, 529.516  # PDF-space box of the glyph

    word = _pdfplumber_word_box(char_y0, char_y1, page_height, mediabox_top)
    y0, y1 = PdfExtractor._word_y_range(word, page_height, mediabox_top)

    # Round-trip through pdfplumber's forward conversion must return the char box.
    assert y0 == pytest.approx(char_y0)
    assert y1 == pytest.approx(char_y1)


@pytest.mark.parametrize("mediabox_top", [0, -100, -250.5])
def test_derived_shift_equals_mediabox_origin(mediabox_top):
    """The difference to the naive height-bottom inversion is exactly mediabox_top."""
    page_height = 792.0
    word = _pdfplumber_word_box(517.516, 529.516, page_height, mediabox_top)

    y0, y1 = PdfExtractor._word_y_range(word, page_height, mediabox_top)
    naive_y0 = page_height - word["bottom"]
    naive_y1 = page_height - word["top"]

    assert y0 - naive_y0 == pytest.approx(mediabox_top)
    assert y1 - naive_y1 == pytest.approx(mediabox_top)


def test_zero_mediabox_origin_is_a_plain_inversion():
    word = {"top": 62.5, "bottom": 74.5}
    assert PdfExtractor._word_y_range(word, 792.0, 0.0) == pytest.approx((717.5, 729.5))


def test_word_y0_y1_pass_through_when_provided():
    word = {"y0": 10.0, "y1": 20.0, "top": 999.0, "bottom": 999.0}
    assert PdfExtractor._word_y_range(word, 792.0, -100.0) == (10.0, 20.0)


@pytest.mark.parametrize(
    "mediabox, baseline",
    [
        (b"[0 0 612 792]", 520),      # origin at y = 0
        (b"[0 100 612 892]", 620),    # non-zero MediaBox vertical origin
    ],
)
def test_extracted_words_align_with_chars(tmp_path, mediabox, baseline):
    path = _text_pdf(tmp_path / "text.pdf", mediabox, "mediaboxword", baseline)

    extractor = PdfExtractor(path)
    try:
        page = extractor.extract_page(1)
    finally:
        extractor.close()

    assert page["height"] == pytest.approx(792.0)
    assert len(page["words"]) == 1
    word = page["words"][0]
    assert word["text"] == "mediaboxword"

    # Both MediaBoxes place the baseline at PDF-space y = 520, so the word box
    # must be identical and must match the glyph box reported for the chars.
    assert word["y0"] == pytest.approx(517.516, abs=0.5)
    assert word["y1"] == pytest.approx(529.516, abs=0.5)

    char_y0 = min(c["y0"] for c in page["chars"])
    char_y1 = max(c["y1"] for c in page["chars"])
    assert word["y0"] == pytest.approx(char_y0, abs=0.01)
    assert word["y1"] == pytest.approx(char_y1, abs=0.01)

    # A word can never fall outside the page box the renderer draws it into.
    assert 0.0 <= word["y0"] < word["y1"] <= page["height"]


def test_words_carry_font_attributes(tmp_path):
    """Word objects expose the font/size of their chars (Inspector + filters)."""
    from reportlab.pdfgen import canvas as rl_canvas

    path = tmp_path / "word-fonts.pdf"
    doc = rl_canvas.Canvas(str(path))
    doc.setFont("Helvetica-Bold", 18)
    doc.drawString(72, 700, "Font Word")
    doc.save()

    extractor = PdfExtractor(str(path))
    try:
        page = extractor.extract_page(1)
    finally:
        extractor.close()

    by_text = {word["text"]: word for word in page["words"]}
    assert by_text["Font"]["fontname"] == "Helvetica-Bold"
    assert by_text["Font"]["size"] == pytest.approx(18.0)
    assert by_text["Word"]["fontname"] == "Helvetica-Bold"
    assert by_text["Word"]["size"] == pytest.approx(18.0)
