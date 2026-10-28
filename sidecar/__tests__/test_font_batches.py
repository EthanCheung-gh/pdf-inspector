"""Paginated font analysis: a page range must answer on its own and compose.

``analyze_fonts()`` used to walk every page synchronously, so the sidecar could
not serve the next request (page extraction) until the whole document was laid
out. Ranges are now computed per request, without reading or populating the
full-document cache, and the union of single-page batches must equal the full
analysis.
"""

import json
import sys
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402
from main import SidecarSession  # noqa: E402


def _draw_outlined(c, x, y, text, font, size, rgb):
    """Draw stroked text so pdfplumber reports a per-call ``stroking_color``.

    Filled text (the default render mode) always reports the same stroking
    color, which would make the ``colors`` assertions meaningless.
    """
    c.setStrokeColorRGB(*rgb)
    text_obj = c.beginText(x, y)
    text_obj.setTextRenderMode(1)  # stroke-only text -> stroke color applies
    text_obj.setFont(font, size)
    text_obj.textLine(text)
    c.drawText(text_obj)


@pytest.fixture()
def batched_pdf(tmp_path):
    """3 pages with a different font/size/color mix per page.

    page 1: Helvetica 10 red "alpha" (5 chars), Helvetica 14 blue "beta" (4)
    page 2: Helvetica 10 blue "gamma" (5)
    page 3: Courier 12 green "delta" (5)
    """
    path = tmp_path / "batched.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    _draw_outlined(c, 50, 700, "alpha", "Helvetica", 10, (1, 0, 0))
    _draw_outlined(c, 50, 650, "beta", "Helvetica", 14, (0, 0, 1))
    c.showPage()
    _draw_outlined(c, 50, 700, "gamma", "Helvetica", 10, (0, 0, 1))
    c.showPage()
    _draw_outlined(c, 50, 700, "delta", "Courier", 12, (0, 0.5, 0))
    c.showPage()
    c.save()
    return str(path)


@pytest.fixture()
def blank_pdf(tmp_path):
    """One page with no text at all: a valid range that finds no fonts."""
    path = tmp_path / "blank.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.showPage()
    c.save()
    return str(path)


@pytest.fixture()
def zero_page_pdf(tmp_path):
    """A hand-built PDF with a genuinely empty page tree (reportlab cannot make one)."""
    path = tmp_path / "zero_pages.pdf"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [] /Count 0 >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
    xref_position = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_position}\n%%EOF\n"
    ).encode("ascii")
    path.write_bytes(bytes(out))
    return str(path)


def _fonts_by_name(result):
    return {font["fontname"]: font for font in result["fonts"]}


def _merge_batches(batches):
    """Re-merge per-range results the way the renderer would.

    Batches are merged in the order they were requested (ascending pages), so
    ``pages`` stays ascending and ``colors`` keeps first-seen order.
    """
    merged = {}
    for batch in batches:
        for font in batch["fonts"]:
            entry = merged.setdefault(font["fontname"], {
                "fontname": font["fontname"],
                "pages": [],
                "charCount": 0,
                "sizeMin": font["sizeMin"],
                "sizeMax": font["sizeMax"],
                "colors": [],
            })
            entry["charCount"] += font["charCount"]
            entry["sizeMin"] = min(entry["sizeMin"], font["sizeMin"])
            entry["sizeMax"] = max(entry["sizeMax"], font["sizeMax"])
            for color in font["colors"]:
                if color not in entry["colors"]:
                    entry["colors"].append(color)
            for page in font["pages"]:
                if page not in entry["pages"]:
                    entry["pages"].append(page)
    return {
        "fonts": sorted(
            merged.values(), key=lambda f: f["charCount"], reverse=True
        )
    }


# --- range selection -------------------------------------------------------


def test_page_one_only_returns_page_one_data(batched_pdf):
    result = PdfExtractor(batched_pdf).analyze_fonts(1, 1)
    fonts = _fonts_by_name(result)

    assert list(fonts) == ["Helvetica"], "page 3's Courier must not leak into page 1"
    helvetica = fonts["Helvetica"]
    assert helvetica["pages"] == [1]
    assert helvetica["charCount"] == 9  # "alpha" (5) + "beta" (4)
    assert helvetica["sizeMin"] == 10
    assert helvetica["sizeMax"] == 14
    assert len(helvetica["colors"]) == 2, "red (alpha) and blue (beta) are distinct"


def test_range_of_two_pages_covers_both(batched_pdf):
    result = PdfExtractor(batched_pdf).analyze_fonts(2, 3)
    fonts = _fonts_by_name(result)

    assert set(fonts) == {"Helvetica", "Courier"}
    assert fonts["Helvetica"]["pages"] == [2]
    assert fonts["Helvetica"]["charCount"] == 5  # "gamma"
    assert fonts["Helvetica"]["sizeMin"] == 10
    assert fonts["Helvetica"]["sizeMax"] == 10
    assert fonts["Courier"]["pages"] == [3]
    assert fonts["Courier"]["charCount"] == 5  # "delta"
    assert fonts["Courier"]["sizeMin"] == 12
    assert fonts["Courier"]["sizeMax"] == 12
    # Sorted by charCount descending, exactly like the full analysis.
    counts = [font["charCount"] for font in result["fonts"]]
    assert counts == sorted(counts, reverse=True)


def test_one_sided_ranges_default_to_document_bounds(batched_pdf):
    extractor = PdfExtractor(batched_pdf)

    assert extractor.analyze_fonts(2, None) == extractor.analyze_fonts(2, 3)
    assert extractor.analyze_fonts(None, 2) == extractor.analyze_fonts(1, 2)

    tail = _fonts_by_name(extractor.analyze_fonts(2, None))
    assert tail["Helvetica"]["pages"] == [2]
    assert tail["Courier"]["pages"] == [3]

    head = _fonts_by_name(extractor.analyze_fonts(None, 2))
    assert head["Helvetica"]["pages"] == [1, 2]
    assert head["Helvetica"]["charCount"] == 14  # 9 on page 1 + 5 on page 2
    assert "Courier" not in head


# --- ranges agree with the full analysis -----------------------------------


def test_range_fields_match_the_full_analysis_for_the_pages_it_covers(batched_pdf):
    extractor = PdfExtractor(batched_pdf)
    full = _fonts_by_name(extractor.analyze_fonts())

    # Pages 1-2 are exactly the pages Helvetica appears on, so every field must
    # be byte-identical to the full-document entry.
    helvetica_batch = _fonts_by_name(extractor.analyze_fonts(1, 2))["Helvetica"]
    assert helvetica_batch == full["Helvetica"]

    # Same for Courier, which only exists on page 3.
    courier_batch = _fonts_by_name(extractor.analyze_fonts(3, 3))["Courier"]
    assert courier_batch == full["Courier"]

    # A partial range reports the same sizes/colors for the pages it sees, in
    # first-seen order: page 1 alone introduces red then blue, page 2 reuses
    # that blue instead of introducing a new color.
    page_one = _fonts_by_name(extractor.analyze_fonts(1, 1))["Helvetica"]
    page_two = _fonts_by_name(extractor.analyze_fonts(2, 2))["Helvetica"]
    assert page_one["colors"] == full["Helvetica"]["colors"]
    assert page_two["colors"] == [page_one["colors"][1]]
    assert page_two["sizeMin"] == page_two["sizeMax"] == 10


def test_single_page_batches_compose_into_the_full_result(batched_pdf):
    extractor = PdfExtractor(batched_pdf)
    full = extractor.analyze_fonts()

    batches = [extractor.analyze_fonts(page, page) for page in (1, 2, 3)]
    merged = _merge_batches(batches)

    assert merged == full
    assert _fonts_by_name(merged)["Helvetica"]["pages"] == [1, 2]
    assert _fonts_by_name(merged)["Helvetica"]["charCount"] == 14
    assert [font["fontname"] for font in merged["fonts"]] == ["Helvetica", "Courier"]

    # Batches and merged results cross the JSON-RPC boundary untouched.
    for payload in [*batches, merged, full]:
        json.dumps(payload)


# --- cache behaviour -------------------------------------------------------


def test_range_neither_reads_nor_replaces_the_full_document_cache(batched_pdf):
    extractor = PdfExtractor(batched_pdf)
    full = extractor.analyze_fonts()
    cached = extractor._font_stats_cache
    assert cached is full

    batch = extractor.analyze_fonts(1, 1)
    assert batch is not full
    assert _fonts_by_name(batch)["Helvetica"]["pages"] == [1]
    assert extractor._font_stats_cache is cached, "a range must not replace the cache"
    assert extractor.analyze_fonts() is full, "the full result stays memoized"

    # Even a poisoned cache must not leak into a range result.
    sentinel = {"fonts": [{
        "fontname": "Sentinel", "pages": [99], "charCount": 1,
        "sizeMin": 0.0, "sizeMax": 0.0, "colors": [],
    }]}
    extractor._font_stats_cache = sentinel
    poisoned = extractor.analyze_fonts(2, 2)
    assert [font["fontname"] for font in poisoned["fonts"]] == ["Helvetica"]
    assert extractor._font_stats_cache is sentinel


def test_range_recomputes_instead_of_reading_the_cache(batched_pdf, monkeypatch):
    extractor = PdfExtractor(batched_pdf)
    calls = []
    original = extractor._compute_font_stats

    def spy(*args):
        calls.append(args)
        return original(*args)

    monkeypatch.setattr(extractor, "_compute_font_stats", spy)

    extractor.analyze_fonts()
    assert calls == [()], "the no-arg call keeps using the uncached full computation"

    extractor.analyze_fonts(2, 3)
    assert calls == [(), (2, 3)], "a range must compute its own pages"


def test_range_first_then_full_still_returns_the_complete_document(batched_pdf):
    extractor = PdfExtractor(batched_pdf)

    batch = extractor.analyze_fonts(2, 2)
    assert _fonts_by_name(batch)["Helvetica"]["pages"] == [2]
    assert extractor._font_stats_cache is None, "a range must not populate the cache"

    full = _fonts_by_name(extractor.analyze_fonts())
    assert full["Helvetica"]["pages"] == [1, 2]
    assert full["Helvetica"]["charCount"] == 14
    assert full["Courier"]["pages"] == [3]
    assert full["Courier"]["charCount"] == 5


# --- validation ------------------------------------------------------------


@pytest.mark.parametrize("start,end", [
    (0, 1),      # zero is not a page number
    (1, 4),      # past the last page
    (2, 1),      # reversed
    (-1, 2),     # negative
    (3, 2),      # reversed, both valid page numbers
])
def test_out_of_bounds_ranges_raise_value_error(batched_pdf, start, end):
    with pytest.raises(ValueError, match="Invalid page range"):
        PdfExtractor(batched_pdf).analyze_fonts(start, end)


def test_out_of_bounds_message_names_the_range_and_document_size(batched_pdf):
    with pytest.raises(ValueError) as excinfo:
        PdfExtractor(batched_pdf).analyze_fonts(0, 5)
    assert str(excinfo.value) == "Invalid page range: 0-5 (document has 3 pages)"


@pytest.mark.parametrize("start,end", [
    (True, 2),    # bool is an int subclass but not a page number
    (1, False),
    (1.0, 2),     # float
    (1, 2.5),
    ("1", 2),     # str
    (1, "2"),
])
def test_non_integer_page_numbers_are_rejected(batched_pdf, start, end):
    with pytest.raises(ValueError, match="page numbers must be integers"):
        PdfExtractor(batched_pdf).analyze_fonts(start, end)


def test_blank_page_document_is_empty_for_full_and_range(blank_pdf):
    extractor = PdfExtractor(blank_pdf)
    assert extractor.analyze_fonts() == {"fonts": []}
    # The page exists, it simply has no chars.
    assert extractor.analyze_fonts(1, 1) == {"fonts": []}


def test_zero_page_document_allows_only_the_full_analysis(zero_page_pdf):
    extractor = PdfExtractor(zero_page_pdf)
    assert extractor.analyze_fonts() == {"fonts": []}

    for start, end in [(1, 1), (None, 1), (1, None), (1, 0)]:
        with pytest.raises(ValueError, match="Invalid page range"):
            extractor.analyze_fonts(start, end)


# --- session wiring --------------------------------------------------------


class _RecordingExtractor:
    """Records ``analyze_fonts`` arguments without touching pdfplumber."""

    def __init__(self, path, password=None):
        self.path = path
        self.password = password
        self.font_calls = []
        self.closes = 0

    def get_metadata(self):
        return {"pages": 3, "title": self.path}

    def analyze_fonts(self, start_page=None, end_page=None):
        self.font_calls.append((start_page, end_page))
        if start_page is not None and start_page < 1:
            raise ValueError(
                f"Invalid page range: {start_page}-{end_page} (document has 3 pages)"
            )
        return {"fonts": []}

    def close(self):
        self.closes += 1


def test_session_forwards_page_range_arguments_positionally():
    fake = _RecordingExtractor("doc.pdf")
    session = SidecarSession(extractor_factory=lambda path, password=None: fake)
    session.handle("open", {"path": "doc.pdf"}, request_id=1)

    full = session.handle("analyze_fonts", {}, request_id=2)
    ranged = session.handle("analyze_fonts", {"start_page": 1, "end_page": 2}, request_id=3)
    one_sided = session.handle("analyze_fonts", {"start_page": 2}, request_id=4)

    assert full == {"id": 2, "result": {"fonts": []}}
    assert ranged == {"id": 3, "result": {"fonts": []}}
    assert one_sided == {"id": 4, "result": {"fonts": []}}
    assert fake.font_calls == [(None, None), (1, 2), (2, None)]


def test_session_reports_validation_errors_in_the_normal_envelope(batched_pdf):
    session = SidecarSession()
    assert "error" not in session.handle("open", {"path": batched_pdf}, request_id=1)

    invalid = session.handle("analyze_fonts", {"start_page": 0, "end_page": 2}, request_id=2)
    assert invalid == {"id": 2, "error": "Invalid page range: 0-2 (document has 3 pages)"}
    assert "result" not in invalid

    # A valid range still answers normally after the rejected request.
    ranged = session.handle("analyze_fonts", {"start_page": 3, "end_page": 3}, request_id=3)
    assert "error" not in ranged
    assert [font["fontname"] for font in ranged["result"]["fonts"]] == ["Courier"]
    assert ranged["result"]["fonts"][0]["pages"] == [3]
