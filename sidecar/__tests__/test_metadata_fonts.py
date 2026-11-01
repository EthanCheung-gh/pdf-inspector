"""Metadata font collection must stay cheap, resilient, and resource-based.

``open`` returns ``get_metadata()``; walking ``page.chars`` there requires full
text layout of every page and times out on large PDFs. These tests pin the
resource-based scan and the ``analyze_fonts()`` cache.
"""

import json
import re
import sys
from pathlib import Path

import pytest
import reportlab
from pdfminer.psparser import LIT
from pdfplumber.page import Page as PdfPlumberPage
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402


@pytest.fixture()
def two_font_pdf(tmp_path):
    """Page 1 sets Helvetica, page 2 sets Courier (reportlab also embeds both as resources)."""
    path = tmp_path / "two_fonts.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.setFont("Helvetica", 12)
    c.drawString(72, 720, "alpha")
    c.showPage()
    c.setFont("Courier", 12)
    c.drawString(72, 720, "beta")
    c.save()
    return str(path)


@pytest.fixture()
def blank_pdf(tmp_path):
    """A minimal one-page PDF with no /Font resources at all.

    reportlab always emits a Helvetica resource, so this is hand-built: only a
    page tree and an empty content stream.
    """
    path = tmp_path / "blank.pdf"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        b"<< /Length 0 >>\nstream\n\nendstream",
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


# --- helpers for the fake (monkeypatched) document -------------------------


class _Ref:
    """Stand-in for pdfminer's PDFObjRef."""

    def __init__(self, value):
        self._value = value

    def resolve(self):
        return self._value


class _BrokenRef:
    def resolve(self):
        raise RuntimeError("broken object reference")


class _ExplodingDict(dict):
    def get(self, key, default=None):
        raise RuntimeError("broken font dictionary")


class _AnonymousLiteral:
    """A BaseFont stand-in exposing no ``.name``, forcing the fallback path."""

    def __str__(self):
        return "/'FallbackFont'"


class _FakePageObj:
    def __init__(self, resources):
        self.resources = resources


class _FakePage:
    def __init__(self, resources, width=100.0, height=200.0):
        self.page_obj = _FakePageObj(resources)
        self.width = width
        self.height = height


class _ExplodingResourcesPage:
    width = 100.0
    height = 200.0

    @property
    def page_obj(self):
        raise RuntimeError("broken page object")


class _FakePdf:
    pdf_version = "1.7"
    is_encrypted = False
    metadata = {"Title": "T", "Author": "A", "Producer": "P"}

    def __init__(self, pages):
        self.pages = pages


def _extractor_for_fake_pdf(pages) -> PdfExtractor:
    extractor = PdfExtractor.__new__(PdfExtractor)
    extractor._path = "fake.pdf"
    extractor._password = None
    extractor._pdf = _FakePdf(pages)
    extractor._font_stats_cache = None
    extractor._font_info_cache = None
    return extractor


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


def _font_only_pdf(path: Path, font_object: bytes, extra_objects: list[bytes]) -> str:
    """One page whose only resource is /F1 -> object 5, plus ``extra_objects``."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
        b" /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length 0 >>\nstream\n\nendstream",
        font_object,
    ] + extra_objects
    return _write_pdf(path, objects)


def _font_info_by_name(metadata: dict) -> dict:
    return {info["fontname"]: info for info in metadata["fontInfo"]}


# --- get_metadata: no page layout ------------------------------------------


def _forbidden_property(accesses, label):
    def getter(self):
        accesses.append(label)
        raise AssertionError(f"{label} must not be accessed by get_metadata")

    return property(getter)


def test_get_metadata_reads_font_resources_without_laying_out_pages(two_font_pdf, monkeypatch):
    accesses: list[str] = []
    monkeypatch.setattr(PdfPlumberPage, "chars", _forbidden_property(accesses, "page.chars"))
    monkeypatch.setattr(PdfPlumberPage, "objects", _forbidden_property(accesses, "page.objects"))

    metadata = PdfExtractor(two_font_pdf).get_metadata()

    assert accesses == [], "metadata must not parse page content"
    assert metadata["fonts"] == ["Courier", "Helvetica"]
    assert metadata["pages"] == 2
    assert metadata["page_w"] == float(letter[0])
    assert metadata["page_h"] == float(letter[1])
    assert isinstance(metadata["version"], str)
    assert metadata["encrypted"] is False
    assert isinstance(metadata["title"], str)
    assert isinstance(metadata["author"], str)
    assert metadata["producer"], "reportlab always sets /Producer"
    json.dumps(metadata)


def test_get_metadata_reports_no_fonts_for_a_blank_document(blank_pdf):
    metadata = PdfExtractor(blank_pdf).get_metadata()
    assert metadata["fonts"] == []
    assert metadata["pages"] == 1
    assert metadata["page_w"] == 612.0
    assert metadata["page_h"] == 792.0


# --- get_metadata: BaseFont naming and resilience --------------------------


def test_subset_prefixed_base_font_names_are_returned_as_is(tmp_path):
    vera = Path(reportlab.__file__).parent / "fonts" / "Vera.ttf"
    if not vera.exists():  # pragma: no cover - reportlab always ships Vera.ttf
        pytest.skip("reportlab bundled Vera.ttf unavailable")

    pdfmetrics.registerFont(TTFont("MetadataSubsetProbe", str(vera)))
    path = tmp_path / "subset.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.setFont("MetadataSubsetProbe", 12)
    c.drawString(72, 720, "subset text")
    c.showPage()
    c.save()

    extractor = PdfExtractor(str(path))
    fonts = extractor.get_metadata()["fonts"]

    subset = [name for name in fonts if "+" in name]
    assert len(subset) == 1
    name = subset[0]
    # reportlab writes the six-uppercase-letter subset tag; no "/" or quotes leak in.
    assert re.fullmatch(r"[A-Z]{6}\+BitstreamVeraSans-Roman", name), name
    assert not name.startswith(("/", "'"))

    # Independent oracle: the embedded subset is what the page actually renders.
    char_fonts = {f["fontname"] for f in extractor.analyze_fonts()["fonts"]}
    assert name in char_fonts


def test_malformed_font_resources_are_skipped_not_raised():
    good_page = _FakePage({
        "Font": _Ref({
            "F1": _Ref({"Type": LIT("Font"), "Subtype": LIT("Type1"),
                        "BaseFont": LIT("Helvetica")}),
            # Composite (Type0) font: BaseFont lives on the top-level dict.
            "F2": _Ref({"Type": LIT("Font"), "Subtype": LIT("Type0"),
                        "BaseFont": LIT("ABCDEF+ArialUnicodeMS"),
                        "DescendantFonts": [_BrokenRef()]}),
            # No `.name` on BaseFont: the PSLiteral-style fallback still works.
            "F3": _Ref({"BaseFont": _AnonymousLiteral()}),
            # Every kind of unusable resource below must be ignored.
            "F4": _BrokenRef(),
            "F5": _Ref("not-a-font-dict"),
            "F6": _Ref({"Type": LIT("Font"), "Subtype": LIT("Type3")}),  # no BaseFont
            "F7": _Ref(_ExplodingDict()),
        }),
    })
    empty_resources_page = _FakePage({})
    garbage_resources_page = _FakePage("not-a-resource-dict")
    exploding_page = _ExplodingResourcesPage()

    extractor = _extractor_for_fake_pdf([
        good_page,
        empty_resources_page,
        garbage_resources_page,
        exploding_page,
    ])

    metadata = extractor.get_metadata()

    assert metadata["fonts"] == ["ABCDEF+ArialUnicodeMS", "FallbackFont", "Helvetica"]
    assert metadata["pages"] == 4
    assert metadata["title"] == "T"
    assert metadata["author"] == "A"
    assert metadata["producer"] == "P"
    json.dumps(metadata)

    # fontInfo must degrade instead of raising for the same broken resources.
    info = _font_info_by_name(metadata)
    assert set(info) == set(metadata["fonts"])
    assert info["Helvetica"]["embedding"] == "standard14"
    assert info["Helvetica"]["embedded"] is False
    # Type0 font whose DescendantFonts reference is broken: no claim either way.
    assert info["ABCDEF+ArialUnicodeMS"]["embedding"] == "unknown"
    assert info["ABCDEF+ArialUnicodeMS"]["embedded"] is False
    assert info["ABCDEF+ArialUnicodeMS"]["subset"] is True
    assert info["FallbackFont"]["embedding"] == "not-embedded"
    assert info["FallbackFont"]["embedded"] is False


# --- fontInfo: embedding detection -----------------------------------------


def test_standard_14_fonts_are_reported_as_not_embedded(two_font_pdf):
    metadata = PdfExtractor(two_font_pdf).get_metadata()

    info = _font_info_by_name(metadata)
    assert set(info) == {"Helvetica", "Courier"}
    for entry in info.values():
        assert entry["embedded"] is False
        assert entry["embedding"] == "standard14"
        assert entry["fontFileType"] is None
        assert entry["subset"] is False
        assert entry["subtype"] == "Type1"
        assert entry["encoding"] == "WinAnsiEncoding"
        assert entry["hasToUnicode"] is False
    json.dumps(metadata["fontInfo"])


def test_embedded_true_type_subset_reports_descriptor_details(tmp_path):
    vera = Path(reportlab.__file__).parent / "fonts" / "Vera.ttf"
    if not vera.exists():  # pragma: no cover - reportlab always ships Vera.ttf
        pytest.skip("reportlab bundled Vera.ttf unavailable")

    pdfmetrics.registerFont(TTFont("FontInfoEmbeddedProbe", str(vera)))
    path = tmp_path / "embedded.pdf"
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.setFont("FontInfoEmbeddedProbe", 12)
    c.drawString(72, 720, "embedded text")
    c.showPage()
    c.save()

    metadata = PdfExtractor(str(path)).get_metadata()
    info = _font_info_by_name(metadata)
    # reportlab always leaves its default Helvetica resource in the document.
    assert len(info) == 2
    embedded_names = [name for name in info if name != "Helvetica"]
    assert len(embedded_names) == 1
    entry = info[embedded_names[0]]

    assert re.fullmatch(r"[A-Z]{6}\+BitstreamVeraSans-Roman", entry["fontname"])
    assert entry["embedded"] is True
    assert entry["embedding"] == "embedded"
    assert entry["subtype"] == "TrueType"
    assert entry["fontFileType"] == "TrueType"
    assert entry["subset"] is True
    assert entry["hasToUnicode"] is True

    assert info["Helvetica"]["embedding"] == "standard14"


def test_type0_font_reads_the_descendant_font_descriptor(tmp_path):
    """A Type0 font keeps /FontDescriptor on its descendant, not on the top dict."""
    path = _font_only_pdf(
        tmp_path / "type0.pdf",
        b"<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+SomeCIDFont"
        b" /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>",
        [
            b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+SomeCIDFont"
            b" /FontDescriptor 7 0 R >>",
            b"<< /Type /FontDescriptor /FontName /ABCDEF+SomeCIDFont /FontFile2 8 0 R >>",
            b"<< /Length 4 >>\nstream\nABCD\nendstream",
            b"<< /Length 4 >>\nstream\nABCD\nendstream",
        ],
    )

    entry = PdfExtractor(path).get_metadata()["fontInfo"][0]

    assert entry["fontname"] == "ABCDEF+SomeCIDFont"
    assert entry["subtype"] == "Type0"
    assert entry["embedded"] is True
    assert entry["embedding"] == "embedded"
    assert entry["fontFileType"] == "TrueType"
    assert entry["encoding"] == "Identity-H"
    assert entry["hasToUnicode"] is True
    assert entry["subset"] is True


@pytest.mark.parametrize(
    ("font_file_object", "expected"),
    [
        (b"<< /Length 4 >>\nstream\nABCD\nendstream", "Type1"),
        (b"<< /Length 4 /Subtype /Type1C >>\nstream\nABCD\nendstream", "CFF"),
        (b"<< /Length 4 /Subtype /CIDFontType0C >>\nstream\nABCD\nendstream", "CFF"),
        (b"<< /Length 4 /Subtype /OpenType >>\nstream\nABCD\nendstream", "OpenType"),
    ],
)
def test_font_file_type_follows_the_descriptor_key(tmp_path, font_file_object, expected):
    font_file_key = b"FontFile3" if b"/Subtype" in font_file_object else b"FontFile"
    path = _font_only_pdf(
        tmp_path / "font-file.pdf",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Custom"
        b" /FontDescriptor 6 0 R >>",
        [
            b"<< /Type /FontDescriptor /FontName /ABCDEF+Custom /" + font_file_key
            + b" 7 0 R >>",
            font_file_object,
        ],
    )

    entry = PdfExtractor(path).get_metadata()["fontInfo"][0]

    assert entry["embedded"] is True
    assert entry["fontFileType"] == expected


def test_descriptor_without_font_file_is_not_embedded(tmp_path):
    path = _font_only_pdf(
        tmp_path / "unembedded.pdf",
        b"<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Custom"
        b" /FontDescriptor 6 0 R >>",
        [b"<< /Type /FontDescriptor /FontName /ABCDEF+Custom >>"],
    )

    entry = PdfExtractor(path).get_metadata()["fontInfo"][0]

    assert entry["embedded"] is False
    assert entry["embedding"] == "not-embedded"
    assert entry["fontFileType"] is None


def test_font_info_is_cached_and_deduplicated(monkeypatch):
    def font_resource(name):
        return _FakePage({
            "Font": _Ref({
                "F1": _Ref({"Type": LIT("Font"), "Subtype": LIT("Type1"),
                            "BaseFont": LIT(name)}),
            }),
        })

    extractor = _extractor_for_fake_pdf([font_resource("Helvetica"),
                                         font_resource("Helvetica")])

    calls: list[str] = []
    original = PdfExtractor._font_info.__func__

    def spy(cls, font_obj):
        calls.append(cls._base_font_name(font_obj) or "")
        return original(cls, font_obj)

    monkeypatch.setattr(PdfExtractor, "_font_info", classmethod(spy))

    first = extractor.get_metadata()["fontInfo"]
    calls_after_first = len(calls)
    second = extractor.get_metadata()["fontInfo"]

    assert calls_after_first == 2, "both pages' resources are scanned once"
    assert len(calls) == calls_after_first, "the second call must use the cache"
    assert len(first) == 1, "the same fontname appears only once"
    assert first == second

    # The cache is document state: callers get copies they cannot corrupt.
    first[0]["fontname"] = "mutated"
    assert extractor.get_metadata()["fontInfo"][0]["fontname"] == "Helvetica"


def test_font_info_does_not_layout_pages(two_font_pdf, monkeypatch):
    accesses: list[str] = []
    monkeypatch.setattr(PdfPlumberPage, "chars", _forbidden_property(accesses, "page.chars"))

    metadata = PdfExtractor(two_font_pdf).get_metadata()

    assert accesses == []
    assert len(metadata["fontInfo"]) == len(metadata["fonts"]) == 2


# --- analyze_fonts: cached -------------------------------------------------


def test_analyze_fonts_computes_once_and_returns_the_cached_result(two_font_pdf, monkeypatch):
    extractor = PdfExtractor(two_font_pdf)
    calls: list[int] = []
    original = extractor._compute_font_stats

    def spy():
        calls.append(1)
        return original()

    monkeypatch.setattr(extractor, "_compute_font_stats", spy)

    first = extractor.analyze_fonts()
    second = extractor.analyze_fonts()

    assert len(calls) == 1, "second analyze_fonts() must be served from the cache"
    assert first == second
    assert first["fonts"], "fixture documents have fonts"
    json.dumps(first)

    # A cached call must not walk chars again (i.e. no second page layout).
    monkeypatch.setattr(PdfPlumberPage, "chars", _forbidden_property([], "page.chars"))
    assert extractor.analyze_fonts() == first
    assert len(calls) == 1
