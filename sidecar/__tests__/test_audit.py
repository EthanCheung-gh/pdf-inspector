"""Document audit: document checks, page batches, the report and the RPC.

Real reportlab PDFs pin the checks that depend on actual PDF structures
(Standard 14 vs embedded fonts, page boxes, images, mixed sizes, rotation,
encryption); fake extractors pin the failure paths a real PDF cannot produce on
demand (a page that raises while its batch continues, an unreadable catalog,
cheap document-only checks).
"""

import json
import sys
from io import BytesIO
from pathlib import Path

import pytest
import reportlab
from PIL import Image
from reportlab.lib import pdfencrypt
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import audit  # noqa: E402
from audit import (  # noqa: E402
    AUDIT_CATEGORIES,
    FINDING_KEYS,
    FINGERPRINT_KEY,
    AuditError,
    audit_document,
    audit_file,
    audit_pages,
    sort_findings,
)
from diff import TOOL_NAME, tool_version  # noqa: E402
from extractor import PdfExtractor  # noqa: E402
from main import SidecarSession  # noqa: E402

MEDIA_BOX = {"x0": 0.0, "y0": 0.0, "x1": 612.0, "y1": 792.0}


# --- fixtures and helpers ---------------------------------------------------


def _boxes(**overrides):
    boxes = {
        "media": dict(MEDIA_BOX),
        "crop": None,
        "trim": None,
        "bleed": None,
        "art": None,
    }
    boxes.update(overrides)
    return boxes


def _blank_page(**overrides):
    page = {
        "width": 612.0,
        "height": 792.0,
        "rotation": 0,
        "boxes": _boxes(),
        "chars": [],
        "words": [],
        "rects": [],
        "lines": [],
        "curves": [],
        "images": [],
        "tables": [],
    }
    page.update(overrides)
    return page


def _text_page(text="hello"):
    char = {
        "type": "char",
        "x0": 72.0,
        "y0": 710.0,
        "x1": 90.0,
        "y1": 722.0,
        "text": text[0],
        "fontname": "Helvetica",
        "size": 12.0,
        "color": "#000000",
        "page": 1,
    }
    word = dict(char, type="word", x0=72.0, x1=72.0 + 6.0 * len(text), text=text)
    return _blank_page(chars=[char], words=[word])


def _image_object(box=(200.0, 200.0)):
    width, height = box
    return {
        "type": "image",
        "x0": 72.0,
        "y0": 400.0,
        "x1": 72.0 + width,
        "y1": 400.0 + height,
        "width": width,
        "height": height,
        "stream_id": "p1_img_0",
        "format": "unknown",
        "page": 1,
    }


def _write_pdf(path: Path, objects: list) -> str:
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


def _page_pdf(
    path: Path,
    catalog_extra: bytes = b"",
    page_attributes: bytes = b"",
    content: bytes = b"",
    extra_objects: list = (),
) -> str:
    """One-page PDF with extra catalog entries, page attributes and objects."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R " + catalog_extra + b" >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        + page_attributes
        + b" /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ] + list(extra_objects)
    return _write_pdf(path, objects)


def _png(size: int) -> ImageReader:
    buffer = BytesIO()
    Image.new("RGB", (size, size), (180, 40, 40)).save(buffer, format="PNG")
    buffer.seek(0)
    return ImageReader(buffer)


def _text_pdf(path: Path, pages=("hello",)) -> str:
    """A reportlab PDF (Helvetica = Standard 14); an empty entry is a blank page."""
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.setFont("Helvetica", 12)
    for text in pages:
        if text:
            canvas.drawString(72, 720, text)
        canvas.showPage()
    canvas.save()
    return str(path)


def _image_pdf(path: Path, pixels: int, box=(200, 200)) -> str:
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.drawImage(_png(pixels), 72, 400, width=box[0], height=box[1])
    canvas.showPage()
    canvas.save()
    return str(path)


def _audit_document(path) -> dict:
    extractor = PdfExtractor(str(path))
    try:
        return audit_document(extractor)
    finally:
        extractor.close()


def _audit_pages(path, start_page, end_page) -> dict:
    extractor = PdfExtractor(str(path))
    try:
        return audit_pages(extractor, start_page, end_page)
    finally:
        extractor.close()


def _titles(result) -> list:
    return [finding["title"] for finding in result["findings"]]


def _by_title(result) -> dict:
    return {finding["title"]: finding for finding in result["findings"]}


def _order_key(finding):
    page = finding["page"]
    return (
        AUDIT_CATEGORIES.index(finding["category"]),
        -1 if page is None else page,
        finding["title"],
    )


def _assert_sorted(findings) -> None:
    keys = [_order_key(finding) for finding in findings]
    assert keys == sorted(keys), f"findings are not ordered: {keys}"


# --- fake extractor ---------------------------------------------------------


class _FakeDoc:
    def __init__(self, catalog, encryption):
        self.catalog = catalog
        self.encryption = encryption


class _FakePdf:
    def __init__(self, pages, catalog, encryption):
        self.pages = list(pages)
        self.doc = _FakeDoc(catalog, encryption)


class _FakePage:
    def __init__(self, images=None, geometry=None):
        self.images = list(images or [])
        self.geometry = geometry or {"rotation": 0, "boxes": _boxes()}


class _FakeExtractor:
    """Minimal stand-in for ``PdfExtractor`` with scripted failures."""

    _validate_page_range = PdfExtractor._validate_page_range

    def __init__(
        self,
        page_data=None,
        failures=None,
        metadata=None,
        pages=None,
        catalog=None,
        encryption=None,
    ):
        self._page_data = dict(page_data or {})
        self._failures = dict(failures or {})
        self._metadata = dict(metadata or {})
        self.extract_calls = []
        self.closed = False
        self._pages = list(pages if pages is not None else self._page_data.values())
        self._pdf = _FakePdf(self._pages, catalog if catalog is not None else {}, encryption)

    def get_metadata(self):
        metadata = dict(self._metadata)
        metadata.setdefault("pages", len(self._pages))
        return metadata

    def _page_geometry(self, page):
        return page.geometry

    def extract_page(self, page_num):
        self.extract_calls.append(page_num)
        if page_num in self._failures:
            raise self._failures[page_num]
        return self._page_data.get(page_num, _blank_page())

    def close(self):
        self.closed = True


class _ExplodingCatalog(dict):
    def get(self, key, default=None):
        raise RuntimeError("broken catalog entry")


class _BrokenRef:
    def resolve(self):
        raise RuntimeError("broken object reference")


# --- report schema ----------------------------------------------------------


def test_audit_file_matches_the_shared_report_schema(tmp_path):
    report = audit_file(_text_pdf(tmp_path / "basic.pdf"))

    assert set(report) == {"schemaVersion", "tool", "document", "summary", "findings"}
    assert report["schemaVersion"] == 1
    assert report["tool"] == {"name": TOOL_NAME, "version": tool_version()}
    assert set(report["document"]) == {
        "pages",
        "version",
        "encrypted",
        "title",
        "author",
        "producer",
        "language",
        "tagged",
    }
    assert set(report["summary"]) == {"total", "errors", "warnings", "info"}
    assert report["document"]["pages"] == 1
    for finding in report["findings"]:
        assert set(finding) == set(FINDING_KEYS) | {FINGERPRINT_KEY}
        assert finding["category"] in AUDIT_CATEGORIES
        assert finding["severity"] in {"error", "warning", "info"}
        assert finding["page"] is None or isinstance(finding["page"], int)
        for key in ("evidence", "recommendation"):
            assert finding[key] is None or isinstance(finding[key], str)
    json.dumps(report)


def test_audit_file_is_deterministic_and_free_of_paths_and_timestamps(tmp_path):
    path = _text_pdf(tmp_path / "deterministic.pdf")

    first = audit_file(path)
    second = audit_file(path)

    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    payload = json.dumps(first)
    assert str(tmp_path) not in payload, "findings must not leak absolute paths"
    assert path not in payload
    assert "creationdate" not in payload.lower()
    assert "moddate" not in payload.lower()


def test_schema_version_and_document_keys_are_the_contract():
    assert audit.SCHEMA_VERSION == 1
    assert audit.AUDIT_CATEGORIES == (
        "fonts",
        "pages",
        "images",
        "metadata",
        "structure",
        "security",
    )
    assert audit.AUDIT_SEVERITIES == ("error", "warning", "info")


def test_audit_document_result_has_exactly_the_document_keys(tmp_path):
    result = _audit_document(_text_pdf(tmp_path / "doc.pdf"))

    assert set(result) == {"tool", "document", "findings"}
    assert result["tool"] == {"name": TOOL_NAME, "version": tool_version()}
    assert set(result["document"]) == {
        "pages",
        "version",
        "encrypted",
        "title",
        "author",
        "producer",
        "language",
        "tagged",
    }


def test_audit_pages_result_has_no_document_block(tmp_path):
    result = _audit_pages(_text_pdf(tmp_path / "pages.pdf"), 1, 1)

    assert set(result) == {"tool", "findings"}
    assert result["tool"]["name"] == TOOL_NAME


def test_summary_counts_match_the_findings(tmp_path):
    report = audit_file(_text_pdf(tmp_path / "summary.pdf", pages=("one", "")))

    summary = report["summary"]
    assert summary["total"] == len(report["findings"])
    assert summary["errors"] + summary["warnings"] + summary["info"] == summary["total"]
    assert summary["errors"] == 0, "a readable document has no extraction failures"
    assert summary["warnings"] >= 0


# --- metadata, security, structure -----------------------------------------


def test_missing_title_author_and_language_are_info(tmp_path):
    path = tmp_path / "nometa.pdf"
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.setTitle("")
    canvas.setAuthor("")
    canvas.setFont("Helvetica", 12)
    canvas.drawString(72, 720, "no metadata")
    canvas.save()

    result = _audit_document(path)
    found = _by_title(result)

    assert result["document"]["title"] is None
    assert result["document"]["author"] is None
    assert result["document"]["language"] is None
    for title in (
        "Missing document title",
        "Missing document author",
        "Missing document language",
    ):
        assert found[title]["severity"] == "info"
        assert found[title]["category"] == "metadata"
        assert found[title]["page"] is None


def test_catalog_language_is_reported(tmp_path):
    path = _page_pdf(
        tmp_path / "lang.pdf", catalog_extra=b"/Lang (fr-FR) /StructTreeRoot 5 0 R",
        extra_objects=[b"<< /Type /StructTreeRoot /K [] >>"],
    )

    document = _audit_document(path)["document"]

    assert document["language"] == "fr-FR"
    assert "Missing document language" not in _titles(_audit_document(path))


def test_structure_tree_marks_the_document_as_tagged(tmp_path):
    path = _page_pdf(
        tmp_path / "tagged.pdf",
        catalog_extra=b"/StructTreeRoot 5 0 R",
        extra_objects=[b"<< /Type /StructTreeRoot /K [] >>"],
    )

    result = _audit_document(path)

    assert result["document"]["tagged"] is True
    assert "PDF is not tagged" not in _titles(result)


def test_markinfo_marked_true_marks_the_document_as_tagged(tmp_path):
    path = _page_pdf(
        tmp_path / "marked.pdf", catalog_extra=b"/MarkInfo << /Marked true >>"
    )

    assert _audit_document(path)["document"]["tagged"] is True


def test_untagged_document_is_info(tmp_path):
    result = _audit_document(_text_pdf(tmp_path / "untagged.pdf"))
    found = _by_title(result)

    assert result["document"]["tagged"] is False
    assert found["PDF is not tagged"]["severity"] == "info"
    assert found["PDF is not tagged"]["category"] == "structure"
    assert found["PDF is not tagged"]["page"] is None


def test_encrypted_document_is_a_warning(tmp_path):
    path = tmp_path / "encrypted.pdf"
    encryption = pdfencrypt.StandardEncryption("", "owner", canPrint=1)
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, encrypt=encryption)
    canvas.setFont("Helvetica", 12)
    canvas.drawString(72, 720, "secret")
    canvas.save()

    report = audit_file(path)
    found = _by_title(report)

    assert report["document"]["encrypted"] is True
    assert found["Document is encrypted"]["severity"] == "warning"
    assert found["Document is encrypted"]["category"] == "security"
    assert found["Document is encrypted"]["page"] is None


def test_unreadable_catalog_values_are_treated_as_absent():
    extractor = _FakeExtractor(
        page_data={1: _blank_page()}, catalog=_ExplodingCatalog({"Lang": "en-US"})
    )

    result = audit_document(extractor)

    assert result["document"]["language"] is None
    assert result["document"]["tagged"] is False
    assert "PDF is not tagged" in _titles(result)


def test_broken_structure_reference_is_not_tagged():
    extractor = _FakeExtractor(
        page_data={1: _blank_page()},
        catalog={"StructTreeRoot": _BrokenRef(), "MarkInfo": _BrokenRef()},
    )

    assert audit_document(extractor)["document"]["tagged"] is False


# --- fonts ------------------------------------------------------------------


def test_standard_14_fonts_are_never_reported(tmp_path):
    path = _text_pdf(tmp_path / "standard14.pdf")
    extractor = PdfExtractor(path)
    try:
        metadata = extractor.get_metadata()
        result = audit_document(extractor)
    finally:
        extractor.close()

    assert metadata["fontInfo"], "fixture must reference Helvetica"
    assert all(info["embedding"] == "standard14" for info in metadata["fontInfo"])
    font_titles = [
        finding["title"] for finding in result["findings"] if finding["category"] == "fonts"
    ]
    assert font_titles == [], "Standard 14 fonts must never be reported"
    assert not any("Font not embedded" in title for title in _titles(result))


def test_embedded_true_type_font_is_not_reported(tmp_path):
    vera = Path(reportlab.__file__).parent / "fonts" / "Vera.ttf"
    if not vera.exists():  # pragma: no cover - reportlab always ships Vera.ttf
        pytest.skip("reportlab bundled Vera.ttf unavailable")

    pdfmetrics.registerFont(TTFont("AuditEmbeddedProbe", str(vera)))
    path = tmp_path / "embedded.pdf"
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.setFont("AuditEmbeddedProbe", 12)
    canvas.drawString(72, 720, "embedded text")
    canvas.showPage()
    canvas.save()

    result = _audit_document(path)

    assert "Font not embedded" not in " ".join(_titles(result))
    assert "ToUnicode" not in " ".join(_titles(result))


def test_not_embedded_font_warns(tmp_path):
    path = _page_pdf(
        tmp_path / "not-embedded.pdf",
        page_attributes=b"/Resources << /Font << /F1 5 0 R >> >>",
        extra_objects=[
            b"<< /Type /Font /Subtype /TrueType /BaseFont /CustomSans"
            b" /FontDescriptor 6 0 R >>",
            b"<< /Type /FontDescriptor /FontName /CustomSans >>",
        ],
    )

    found = _by_title(_audit_document(path))

    assert found["Font not embedded: CustomSans"]["severity"] == "warning"
    assert found["Font not embedded: CustomSans"]["category"] == "fonts"
    assert found["Font not embedded: CustomSans"]["page"] is None
    assert "fontFileType=none" in found["Font not embedded: CustomSans"]["evidence"]


def _font_metadata(*font_info):
    return {"pages": 1, "fontInfo": list(font_info)}


def test_unknown_embedding_is_info_and_type3_is_exempt_from_tounicode():
    extractor = _FakeExtractor(
        page_data={1: _blank_page()},
        metadata=_font_metadata(
            {"fontname": "MysteryFont", "embedding": "unknown", "hasToUnicode": False},
            {
                "fontname": "Type3Font",
                "embedding": "embedded",
                "subtype": "Type3",
                "hasToUnicode": False,
            },
        ),
    )

    titles = _titles(audit_document(extractor))

    assert "Font embedding unknown: MysteryFont" in titles
    assert "Font has no ToUnicode mapping: MysteryFont" in titles
    assert "Font has no ToUnicode mapping: Type3Font" not in titles


def test_embedded_font_without_tounicode_warns():
    extractor = _FakeExtractor(
        page_data={1: _blank_page()},
        metadata=_font_metadata(
            {
                "fontname": "ABCDEF+Custom",
                "embedding": "embedded",
                "subtype": "TrueType",
                "fontFileType": "TrueType",
                "hasToUnicode": False,
            }
        ),
    )

    found = _by_title(audit_document(extractor))

    assert found["Font has no ToUnicode mapping: ABCDEF+Custom"]["severity"] == "warning"
    assert "hasToUnicode=false" in found["Font has no ToUnicode mapping: ABCDEF+Custom"]["evidence"]


# --- document-level page geometry ------------------------------------------


def test_mixed_page_sizes_raise_one_warning(tmp_path):
    path = tmp_path / "mixed.pdf"
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.setFont("Helvetica", 12)
    canvas.drawString(72, 720, "letter page")
    canvas.showPage()
    canvas.setPageSize(A4)
    canvas.drawString(72, 720, "a4 page")
    canvas.showPage()
    canvas.save()

    result = _audit_document(path)
    mixed = [f for f in result["findings"] if f["title"] == "Mixed page sizes"]

    assert len(mixed) == 1
    finding = mixed[0]
    assert finding["severity"] == "warning"
    assert finding["category"] == "pages"
    assert finding["page"] is None
    assert "612 x 792" in finding["detail"]
    assert "595.28 x 841.89" in finding["detail"]
    assert "page 1" in finding["detail"] and "page 2" in finding["detail"]


def test_single_page_size_does_not_warn(tmp_path):
    result = _audit_document(_text_pdf(tmp_path / "uniform.pdf", pages=("one", "two")))

    assert "Mixed page sizes" not in _titles(result)


def test_rotation_is_one_info_finding(tmp_path):
    path = _page_pdf(
        tmp_path / "rotated.pdf",
        page_attributes=b"/Rotate 90",
        content=b"BT /F1 12 Tf 72 720 Td (rotated) Tj ET",
    )

    result = _audit_document(path)
    rotated = [f for f in result["findings"] if f["title"] == "Rotated pages"]

    assert len(rotated) == 1
    finding = rotated[0]
    assert finding["severity"] == "info"
    assert finding["category"] == "pages"
    assert finding["page"] is None
    assert "overlays are unavailable" in finding["detail"]
    assert "/Rotate 90" in finding["evidence"]


def test_unrotated_pages_do_not_warn(tmp_path):
    assert "Rotated pages" not in _titles(_audit_document(_text_pdf(tmp_path / "flat.pdf")))


def test_page_box_outside_mediabox_is_one_warning(tmp_path):
    path = _page_pdf(
        tmp_path / "outside.pdf", page_attributes=b"/CropBox [-10 0 620 800]"
    )

    result = _audit_document(path)
    outside = [f for f in result["findings"] if f["title"] == "Page box outside MediaBox"]

    assert len(outside) == 1
    finding = outside[0]
    assert finding["severity"] == "warning"
    assert finding["category"] == "pages"
    assert finding["page"] is None
    assert "CropBox" in finding["detail"]
    assert "page 1" in finding["detail"]
    assert "CropBox" in finding["evidence"]


def test_boxes_inside_mediabox_do_not_warn(tmp_path):
    path = _page_pdf(
        tmp_path / "inside.pdf",
        page_attributes=b"/CropBox [10 10 600 780] /TrimBox [20 20 590 770]",
    )

    assert "Page box outside MediaBox" not in _titles(_audit_document(path))


# --- page-level checks ------------------------------------------------------


def test_empty_page_is_info(tmp_path):
    result = _audit_pages(_text_pdf(tmp_path / "empty.pdf", pages=("",)), 1, 1)
    found = _by_title(result)

    assert found["Page 1 has no content"]["severity"] == "info"
    assert found["Page 1 has no content"]["category"] == "pages"
    assert found["Page 1 has no content"]["page"] == 1


def test_page_with_text_is_not_empty(tmp_path):
    result = _audit_pages(_text_pdf(tmp_path / "text.pdf"), 1, 1)

    assert "Page 1 has no content" not in _titles(result)


def test_image_only_page_warns_about_missing_text(tmp_path):
    path = _image_pdf(tmp_path / "scan.pdf", pixels=600)

    result = _audit_pages(path, 1, 1)
    found = _by_title(result)

    assert found["Page 1 has images but no extractable text"]["severity"] == "warning"
    assert found["Page 1 has images but no extractable text"]["category"] == "images"
    assert "scan" in found["Page 1 has images but no extractable text"]["detail"]
    assert "Page 1 has no content" not in _titles(result)


def test_image_with_text_is_not_treated_as_a_scan(tmp_path):
    path = tmp_path / "image-and-text.pdf"
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.drawImage(_png(600), 72, 400, width=200, height=200)
    canvas.setFont("Helvetica", 12)
    canvas.drawString(72, 720, "caption")
    canvas.showPage()
    canvas.save()

    titles = _titles(_audit_pages(path, 1, 1))

    assert "Page 1 has images but no extractable text" not in titles


def test_low_resolution_image_warns_with_evidence(tmp_path):
    path = _image_pdf(tmp_path / "low-dpi.pdf", pixels=8, box=(200, 200))

    result = _audit_pages(path, 1, 1)
    low = [f for f in result["findings"] if f["title"] == "Page 1 has a low-resolution image"]

    assert len(low) == 1
    finding = low[0]
    assert finding["severity"] == "warning"
    assert finding["category"] == "images"
    assert finding["page"] == 1
    assert "pixels 8 x 8" in finding["evidence"]
    assert "box 200 x 200 pt" in finding["evidence"]
    assert "dpi" in finding["evidence"]


def test_high_resolution_image_is_not_flagged(tmp_path):
    path = _image_pdf(tmp_path / "high-dpi.pdf", pixels=600, box=(200, 200))

    titles = _titles(_audit_pages(path, 1, 1))

    assert "Page 1 has a low-resolution image" not in titles


def test_image_dpi_threshold_is_96():
    assert audit.MIN_IMAGE_DPI == 96.0


def _image_page_data(pixel_size=(8, 8), box=(200.0, 200.0)):
    return _blank_page(images=[_image_object(box)]), [
        {"srcsize": pixel_size, "width": box[0], "height": box[1]}
    ]


def test_zero_sized_image_boxes_are_skipped():
    page, raw_images = _image_page_data()
    page["images"][0]["x1"] = page["images"][0]["x0"]
    extractor = _FakeExtractor(
        page_data={1: page}, pages=[_FakePage(images=raw_images)]
    )

    titles = _titles(audit_pages(extractor, 1, 1))

    assert "Page 1 has a low-resolution image" not in titles


@pytest.mark.parametrize(
    "raw_images",
    [
        [],  # the page exposes no image record at all
        [{}],  # a record without srcsize
        [{"srcsize": None}],
        [{"srcsize": (0, 0)}],  # zero pixel grid: no resolution to compare
        ["not-an-image-record"],
    ],
)
def test_missing_srcsize_never_invents_a_low_dpi_finding(raw_images):
    """``extract_page`` width/height are points; they must not be read as pixels.

    Using them would compute ``200 / (200 / 72) == 72`` dpi for this image and
    report a false positive, so an unavailable ``srcsize`` skips the check.
    """
    page, _ = _image_page_data()
    extractor = _FakeExtractor(
        page_data={1: page}, pages=[_FakePage(images=raw_images)]
    )

    result = audit_pages(extractor, 1, 1)
    titles = _titles(result)

    assert "Page 1 has a low-resolution image" not in titles
    # The images themselves are still seen (and reported as an image-only page).
    assert "Page 1 has images but no extractable text" in titles


def test_srcsize_is_read_before_the_page_layout_is_flushed():
    """The DPI check needs the page cache intact while the page is audited."""
    page, raw_images = _image_page_data(pixel_size=(8, 8))

    class _FlushAwarePage(_FakePage):
        flushed = False

        @property
        def images(self):
            if self.flushed:
                return []
            return self._images

        @images.setter
        def images(self, value):
            self._images = list(value or [])

        def flush_cache(self):
            self.flushed = True

    raw_page = _FlushAwarePage(images=raw_images)
    extractor = _FakeExtractor(page_data={1: page}, pages=[raw_page])

    result = audit_pages(extractor, 1, 1)
    titles = _titles(result)

    assert raw_page.flushed is True, "the layout cache must still be released"
    assert "Page 1 has a low-resolution image" in titles


# --- page ranges and failure handling --------------------------------------


@pytest.mark.parametrize(
    "start, end",
    [(0, 1), (2, 1), (1, 99), (-1, 1), ("1", 1), (True, 1), (1.0, 1)],
)
def test_audit_pages_rejects_invalid_ranges(tmp_path, start, end):
    extractor = PdfExtractor(_text_pdf(tmp_path / "range.pdf", pages=("a", "b")))
    try:
        with pytest.raises(AuditError) as excinfo:
            audit_pages(extractor, start, end)
    finally:
        extractor.close()

    assert "Invalid page range" in str(excinfo.value)
    # AuditError is RpcError/ValueError compatible, so both layers report a message.
    assert isinstance(excinfo.value, ValueError)


def test_audit_pages_survives_a_failing_page():
    extractor = _FakeExtractor(
        page_data={1: _text_page("one"), 2: _text_page("two"), 3: _text_page("three")},
        failures={2: RuntimeError("broken content stream")},
    )

    result = audit_pages(extractor, 1, 3)
    found = _by_title(result)

    assert extractor.extract_calls == [1, 2, 3], "the batch must continue"
    # An unreadable page is the one `error` source, so `--fail-on error` gates it.
    assert found["Page 2 could not be analysed"]["severity"] == "error"
    assert found["Page 2 could not be analysed"]["category"] == "pages"
    assert found["Page 2 could not be analysed"]["page"] == 2
    assert "broken content stream" in found["Page 2 could not be analysed"]["detail"]
    assert "exception=RuntimeError" in found["Page 2 could not be analysed"]["evidence"]
    assert "Page 1 has no content" not in _titles(result)
    assert "Page 3 has no content" not in _titles(result)
    assert audit.summarize_findings(result["findings"])["errors"] == 1


def test_extraction_failure_is_the_only_error_severity():
    extractor = _FakeExtractor(
        page_data={1: _text_page("one"), 2: _blank_page()},
        failures={2: RuntimeError("broken content stream")},
    )

    errors = [
        finding
        for finding in audit_pages(extractor, 1, 2)["findings"]
        if finding["severity"] == "error"
    ]

    assert [finding["title"] for finding in errors] == ["Page 2 could not be analysed"]


def test_audit_pages_limits_the_findings_to_the_requested_range():
    extractor = _FakeExtractor(page_data={1: _blank_page(), 2: _blank_page(), 3: _blank_page()})

    result = audit_pages(extractor, 2, 2)

    assert extractor.extract_calls == [2]
    assert [finding["page"] for finding in result["findings"]] == [2]


# --- ordering ---------------------------------------------------------------


def test_page_findings_are_ordered_by_category_page_and_title():
    image_page, raw_images = _image_page_data()
    extractor = _FakeExtractor(
        page_data={1: image_page, 2: _blank_page()},
        pages=[_FakePage(images=raw_images), _FakePage()],
    )

    result = audit_pages(extractor, 1, 2)
    order = [(f["category"], f["page"], f["title"]) for f in result["findings"]]

    assert order == [
        ("pages", 2, "Page 2 has no content"),
        ("images", 1, "Page 1 has a low-resolution image"),
        ("images", 1, "Page 1 has images but no extractable text"),
    ]


def test_sort_findings_puts_document_findings_first_and_keeps_categories_ordered():
    findings = [
        audit._finding("security", "warning", None, "Document is encrypted", "d"),
        audit._finding("pages", "info", 3, "Page 3 has no content", "d"),
        audit._finding("fonts", "warning", None, "Font not embedded: X", "d"),
        audit._finding("images", "warning", 1, "Page 1 has a low-resolution image", "d"),
        audit._finding("metadata", "info", None, "Missing document title", "d"),
        audit._finding("structure", "info", None, "PDF is not tagged", "d"),
        audit._finding("pages", "warning", None, "Mixed page sizes", "d"),
        audit._finding("pages", "info", 1, "Page 1 has no content", "d"),
    ]

    ordered = [(f["category"], f["page"]) for f in sort_findings(findings)]

    assert ordered == [
        ("fonts", None),
        ("pages", None),
        ("pages", 1),
        ("pages", 3),
        ("images", 1),
        ("metadata", None),
        ("structure", None),
        ("security", None),
    ]


def test_audit_file_findings_are_sorted(tmp_path):
    report = audit_file(_text_pdf(tmp_path / "sorted.pdf", pages=("one", "", "three")))

    _assert_sorted(report["findings"])


# --- cheap document checks --------------------------------------------------


def test_document_audit_does_not_extract_pages():
    class _NoLayoutExtractor(_FakeExtractor):
        def extract_page(self, page_num):  # pragma: no cover - must not be called
            raise AssertionError("audit_document must not extract pages")

    extractor = _NoLayoutExtractor(page_data={1: _blank_page(), 2: _blank_page()})

    result = audit_document(extractor)

    assert result["document"]["pages"] == 2
    assert result["findings"] is not None


# --- audit_file -------------------------------------------------------------


def test_audit_file_rejects_a_missing_file(tmp_path):
    missing = tmp_path / "missing.pdf"

    with pytest.raises(AuditError) as excinfo:
        audit_file(missing)

    assert "Cannot open PDF" in str(excinfo.value)
    assert "missing.pdf" in str(excinfo.value)


def test_audit_file_rejects_a_non_pdf(tmp_path):
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"this is not a PDF")

    with pytest.raises(AuditError):
        audit_file(broken)


def test_audit_file_audits_every_page(tmp_path):
    report = audit_file(_text_pdf(tmp_path / "all-pages.pdf", pages=("one", "", "three")))

    page_findings = [f for f in report["findings"] if f["page"] is not None]
    assert [f["title"] for f in page_findings] == ["Page 2 has no content"]
    assert report["document"]["pages"] == 3


def test_audit_file_accepts_a_path_object(tmp_path):
    path = Path(_text_pdf(tmp_path / "path-object.pdf"))

    assert audit_file(path)["schemaVersion"] == 1


def test_audit_file_merges_document_and_page_findings(tmp_path):
    path = tmp_path / "merged.pdf"
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.setFont("Helvetica", 12)
    canvas.drawString(72, 720, "text page")
    canvas.showPage()
    canvas.showPage()
    canvas.save()

    report = audit_file(path)
    pages = [f["title"] for f in report["findings"] if f["page"] is not None]
    document_level = [f["title"] for f in report["findings"] if f["page"] is None]

    assert pages == ["Page 2 has no content"]
    assert "PDF is not tagged" in document_level


# --- RPC --------------------------------------------------------------------


def test_rpc_audit_methods_require_an_open_document():
    session = SidecarSession()

    assert session.handle("audit_document", {}, request_id=1) == {
        "id": 1,
        "error": "No PDF open",
    }
    assert session.handle(
        "audit_pages", {"start_page": 1, "end_page": 1}, request_id=2
    ) == {"id": 2, "error": "No PDF open"}


def test_rpc_audit_document_dispatches_the_open_document(tmp_path):
    session = SidecarSession()
    path = _text_pdf(tmp_path / "rpc-doc.pdf")
    assert "error" not in session.handle("open", {"path": path}, request_id=1)

    response = session.handle("audit_document", {}, request_id=2)

    assert "error" not in response
    result = response["result"]
    assert set(result) == {"tool", "document", "findings"}
    assert result["document"]["pages"] == 1
    assert result["tool"] == {"name": TOOL_NAME, "version": tool_version()}
    assert result == audit_document(session.extractor)


def test_rpc_audit_pages_dispatches_a_range(tmp_path):
    session = SidecarSession()
    path = _text_pdf(tmp_path / "rpc-pages.pdf", pages=("one", "", "three"))
    assert "error" not in session.handle("open", {"path": path}, request_id=1)

    first = session.handle("audit_pages", {"start_page": 1, "end_page": 1}, request_id=2)
    second = session.handle("audit_pages", {"start_page": 2, "end_page": 2}, request_id=3)

    assert "error" not in first and "error" not in second
    assert set(first["result"]) == {"tool", "findings"}
    assert [f["page"] for f in first["result"]["findings"]] == []
    assert [f["title"] for f in second["result"]["findings"]] == [
        "Page 2 has no content"
    ]


@pytest.mark.parametrize(
    "params",
    [
        {"start_page": 0, "end_page": 1},
        {"start_page": 2, "end_page": 1},
        {"start_page": 1, "end_page": 99},
        {"start_page": "one", "end_page": 1},
        {"start_page": True, "end_page": 1},
    ],
)
def test_rpc_audit_pages_rejects_invalid_ranges(tmp_path, params):
    session = SidecarSession()
    path = _text_pdf(tmp_path / "rpc-invalid.pdf", pages=("one", "two"))
    assert "error" not in session.handle("open", {"path": path}, request_id=1)

    response = session.handle("audit_pages", params, request_id=2)

    assert "result" not in response
    assert "Invalid page range" in response["error"]
    assert "Traceback" not in response["error"]


def test_rpc_audit_pages_defaults_to_the_whole_document(tmp_path):
    """Like ``analyze_fonts``, an omitted bound falls back to the document bounds."""
    session = SidecarSession()
    path = _text_pdf(tmp_path / "rpc-default-range.pdf", pages=("one", ""))
    assert "error" not in session.handle("open", {"path": path}, request_id=1)

    response = session.handle("audit_pages", {}, request_id=2)

    assert "error" not in response
    assert [f["page"] for f in response["result"]["findings"]] == [2]


def test_rpc_audit_leaves_the_session_document_usable(tmp_path):
    session = SidecarSession()
    path = _text_pdf(tmp_path / "rpc-usable.pdf")
    assert "error" not in session.handle("open", {"path": path}, request_id=1)

    assert "error" not in session.handle("audit_document", {}, request_id=2)
    page = session.handle("extract_page", {"page": 1}, request_id=3)

    assert "error" not in page
    assert page["result"]["chars"], "the audit must not consume the open document"
