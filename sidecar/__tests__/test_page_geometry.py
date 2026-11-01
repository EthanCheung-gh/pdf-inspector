"""Page geometry: the five page boxes and /Rotate, straight from the page dict.

The values must be the raw PDF attributes (not pdfplumber's rotation-adjusted
page size), missing boxes must stay null instead of being invented, and
``PageData.width/height`` must keep pdfplumber's existing meaning so the object
overlay does not move.
"""

import json
import sys
from pathlib import Path

import pytest
from pdfminer.psparser import LIT
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402


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


def _page_pdf(path: Path, page_attributes: bytes, content: bytes = b"") -> str:
    """One-page PDF whose page dictionary carries ``page_attributes``."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R " + page_attributes
        + b" /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    return _write_pdf(path, objects)


def _extract(path: str) -> dict:
    extractor = PdfExtractor(path)
    try:
        return extractor.extract_page(1)
    finally:
        extractor.close()


def test_all_page_boxes_and_rotation_are_read(tmp_path):
    path = _page_pdf(
        tmp_path / "boxes.pdf",
        b"/MediaBox [0 0 612 792] /CropBox [10 20 600 780]"
        b" /TrimBox [30 40 580 760] /BleedBox [5 10 605 790]"
        b" /ArtBox [35 45 575 755] /Rotate 90",
    )

    page = _extract(path)

    assert page["rotation"] == 90
    assert page["boxes"] == {
        "media": {"x0": 0.0, "y0": 0.0, "x1": 612.0, "y1": 792.0},
        "crop": {"x0": 10.0, "y0": 20.0, "x1": 600.0, "y1": 780.0},
        "trim": {"x0": 30.0, "y0": 40.0, "x1": 580.0, "y1": 760.0},
        "bleed": {"x0": 5.0, "y0": 10.0, "x1": 605.0, "y1": 790.0},
        "art": {"x0": 35.0, "y0": 45.0, "x1": 575.0, "y1": 755.0},
    }


def test_missing_boxes_stay_null(tmp_path):
    path = tmp_path / "plain.pdf"
    doc = rl_canvas.Canvas(str(path), pagesize=letter)
    doc.setFont("Helvetica", 12)
    doc.drawString(72, 720, "no extra boxes")
    doc.save()

    page = _extract(str(path))

    assert page["rotation"] == 0
    assert page["boxes"]["media"] == {"x0": 0.0, "y0": 0.0, "x1": 612.0, "y1": 792.0}
    for key in ("crop", "trim", "bleed", "art"):
        assert page["boxes"][key] is None, f"{key} must not be fabricated"


@pytest.mark.parametrize(
    ("rotate", "expected"),
    [
        (b"", 0),
        (b"/Rotate 0", 0),
        (b"/Rotate 90", 90),
        (b"/Rotate 180", 180),
        (b"/Rotate 270", 270),
        (b"/Rotate -90", 270),
        (b"/Rotate 450", 90),
        (b"/Rotate 45", 0),
    ],
)
def test_rotation_is_normalized(tmp_path, rotate, expected):
    path = _page_pdf(tmp_path / "rotate.pdf", b"/MediaBox [0 0 612 792] " + rotate)

    assert _extract(path)["rotation"] == expected


def test_non_numeric_rotation_is_treated_as_zero():
    """pdfplumber cannot open such a page; the helper must still not raise."""
    assert PdfExtractor._page_rotation({}) == 0
    assert PdfExtractor._page_rotation({"Rotate": None}) == 0
    assert PdfExtractor._page_rotation({"Rotate": LIT("Ninety")}) == 0
    assert PdfExtractor._page_rotation({"Rotate": 360}) == 0
    assert PdfExtractor._page_rotation({"Rotate": -180}) == 180


class _IndirectRef:
    """Stand-in for pdfminer's PDFObjRef: only ``.resolve()`` matters here."""

    def __init__(self, target):
        self._target = target

    def resolve(self):
        return self._target


def test_indirect_rotation_object_is_resolved():
    """``/Rotate 5 0 R`` must be resolved, not fall back to 0."""
    assert PdfExtractor._page_rotation({"Rotate": _IndirectRef(90)}) == 90
    assert PdfExtractor._page_rotation({"Rotate": _IndirectRef(-90)}) == 270
    # A reference that cannot be read still normalizes to 0 instead of raising.
    assert PdfExtractor._page_rotation({"Rotate": _IndirectRef(None)}) == 0


def test_indirect_rotation_from_a_real_pdf(tmp_path):
    """End-to-end: the page dict points at a separate object holding 90."""
    path = _write_pdf(
        tmp_path / "indirect-rotate.pdf",
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
            b" /Rotate 5 0 R /Contents 4 0 R >>",
            b"<< /Length 0 >>\nstream\n\nendstream",
            b"90",
        ],
    )

    page = _extract(path)

    assert page["rotation"] == 90


def test_page_size_keeps_the_pdfplumber_value(tmp_path):
    """width/height stay pdfplumber's (rotation-aware) size: the overlay basis."""
    path = _page_pdf(
        tmp_path / "size.pdf", b"/MediaBox [0 0 612 792] /Rotate 90"
    )

    page = _extract(path)

    # pdfplumber swaps the page size for a rotated page; boxes stay unrotated.
    assert page["width"] == pytest.approx(792.0)
    assert page["height"] == pytest.approx(612.0)
    assert page["boxes"]["media"] == {"x0": 0.0, "y0": 0.0, "x1": 612.0, "y1": 792.0}


def test_media_box_origin_is_preserved(tmp_path):
    path = _page_pdf(tmp_path / "origin.pdf", b"/MediaBox [0 100 612 892]")

    page = _extract(path)

    assert page["boxes"]["media"] == {"x0": 0.0, "y0": 100.0, "x1": 612.0, "y1": 892.0}
    assert page["width"] == pytest.approx(612.0)
    assert page["height"] == pytest.approx(792.0)


def test_page_geometry_is_json_serializable(tmp_path):
    path = _page_pdf(
        tmp_path / "json.pdf",
        b"/MediaBox [0 0 612 792] /CropBox [0 0 600 780] /Rotate 180",
    )

    page = _extract(path)

    payload = json.dumps(page)
    restored = json.loads(payload)
    assert restored["rotation"] == 180
    assert restored["boxes"]["crop"] == {"x0": 0.0, "y0": 0.0, "x1": 600.0, "y1": 780.0}
