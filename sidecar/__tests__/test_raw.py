"""Raw PDF object graph and content-stream serialization.

Real reportlab PDFs pin the trailer roots, catalog/Pages references, object
serialization, stream metadata and decoded operators; minimal hand-written PDFs
pin multiple content streams and unreadable stream objects. Fake extractors,
documents and streams pin the limits and failure paths a reportlab PDF cannot
produce on demand (depth/items/string caps, endless operators, a parser that
fails mid-stream).
"""

import io
import json
import sys
import zlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image
from pdfminer.pdftypes import PDFObjRef, PDFStream
from pdfminer.psparser import KWD, LIT
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import raw  # noqa: E402
from extractor import PdfExtractor  # noqa: E402
from main import SidecarSession  # noqa: E402
from raw import RawError, raw_document, raw_object, raw_page_content  # noqa: E402

ROOT_LABELS = ["Catalog", "Info", "Encrypt", "ID", "Pages"]


# --- fixtures and helpers ---------------------------------------------------


def _png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 30, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture()
def sample_pdf(tmp_path) -> str:
    """Two pages of text; the first also draws an image XObject."""
    path = tmp_path / "sample.pdf"
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, pdfVersion=(1, 4))
    canvas.setFont("Helvetica", 12)
    canvas.drawString(72, 720, "Hello Raw")
    canvas.drawImage(
        ImageReader(io.BytesIO(_png_bytes())), 72, 620, width=24, height=24
    )
    canvas.showPage()
    canvas.setFont("Helvetica", 12)
    canvas.drawString(72, 720, "Second page")
    canvas.showPage()
    canvas.save()
    return str(path)


@pytest.fixture()
def extractor(sample_pdf):
    instance = PdfExtractor(sample_pdf)
    try:
        yield instance
    finally:
        instance.close()


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


def _two_stream_pdf(tmp_path) -> str:
    first = b"BT /F1 12 Tf (first) Tj ET"
    second = b"0 0 m 10 10 l S"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents [4 0 R 5 0 R] >>",
        b"<< /Length %d >>\nstream\n" % len(first) + first + b"\nendstream",
        b"<< /Length %d >>\nstream\n" % len(second) + second + b"\nendstream",
    ]
    return _write_pdf(tmp_path / "two-streams.pdf", objects)


def _single_content_pdf(tmp_path, content: bytes, name: str) -> str:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    return _write_pdf(tmp_path / name, objects)


def _bad_contents_pdf(tmp_path) -> str:
    """Page whose /Contents points at a non-stream object."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R >>",
        b"42",
    ]
    return _write_pdf(tmp_path / "bad-contents.pdf", objects)


def _all_objects(doc):
    for xref in getattr(doc, "xrefs", []) or []:
        for object_number in sorted(xref.get_objids()):
            yield object_number, doc.getobj(object_number)


def _find_image_stream(doc):
    for object_number, value in _all_objects(doc):
        if isinstance(value, PDFStream) and value.get("Subtype") is LIT("Image"):
            return object_number, value
    return None, None


def _entry(value: dict, key: str):
    for entry in value.get("entries", []):
        if entry["key"] == key:
            return entry["value"]
    raise AssertionError(f"missing dict entry {key!r} in {value!r}")


def _operators(result: dict) -> list[dict]:
    return [operator for stream in result["streams"] for operator in stream["operators"]]


# --- fake pdfminer objects --------------------------------------------------


class _FakeDoc:
    """Minimal PDFDocument stand-in for limits/error tests."""

    def __init__(self, objects=None, xrefs=(), catalog=None, encryption=None):
        self.objects = dict(objects or {})
        self.xrefs = list(xrefs)
        self.catalog = catalog or {}
        self.encryption = encryption
        self.requested: list[int] = []

    def getobj(self, object_number):
        self.requested.append(object_number)
        if object_number not in self.objects:
            raise RuntimeError(f"broken object {object_number}")
        value = self.objects[object_number]
        if isinstance(value, Exception):
            raise value
        return value


class _FakeXRef:
    def __init__(self, positions=None, trailer=None):
        self.positions = dict(positions or {})
        self.trailer = dict(trailer or {})

    def get_pos(self, object_number):
        if object_number not in self.positions:
            raise KeyError(object_number)
        return self.positions[object_number]

    def get_trailer(self):
        return self.trailer


class _FakeExtractor:
    def __init__(self, doc, pages=()):
        self._pdf = SimpleNamespace(doc=doc, pages=list(pages))


class _ExplodingStream(PDFStream):
    """A stream whose payload cannot be decoded."""

    def __init__(self):
        super().__init__({}, b"")

    def get_data(self):
        raise ValueError("corrupt stream payload")


def _fake_page(contents):
    return SimpleNamespace(page_obj=SimpleNamespace(contents=list(contents)))


# --- raw_document -----------------------------------------------------------


def test_raw_document_roots_metadata_and_page_count(extractor, tmp_path):
    document = raw_document(extractor)

    assert set(document) == {"pages", "version", "encrypted", "roots"}
    assert document["pages"] == 2
    assert document["encrypted"] is False
    assert document["version"] is None or isinstance(document["version"], str)

    roots = {root["label"]: root for root in document["roots"]}
    assert [root["label"] for root in document["roots"]] == ROOT_LABELS
    for label in ("Catalog", "Info", "Pages"):
        assert roots[label]["ref"]["objectNumber"] > 0
        assert roots[label]["ref"]["generation"] >= 0
        # Roots stay lazy: referenced values are not fetched for the tree.
        assert roots[label]["value"] is None
    assert roots["Encrypt"] == {"label": "Encrypt", "ref": None, "value": None}
    assert roots["ID"]["ref"] is None
    assert roots["ID"]["value"]["kind"] == "array"
    assert all(item["kind"] == "string" for item in roots["ID"]["value"]["items"])

    # The catalog's Pages ref and the Pages root agree.
    catalog = raw_object(
        extractor,
        roots["Catalog"]["ref"]["objectNumber"],
        roots["Catalog"]["ref"]["generation"],
    )
    catalog_pages = _entry(catalog["value"], "Pages")
    assert catalog_pages["kind"] == "ref"
    assert catalog_pages["ref"] == roots["Pages"]["ref"]

    serialized = json.dumps(document)
    assert str(tmp_path) not in serialized
    assert "timestamp" not in serialized


def test_raw_document_version_from_catalog(tmp_path):
    path = _write_pdf(
        tmp_path / "versioned.pdf",
        [
            b"<< /Type /Catalog /Pages 2 0 R /Version /1.7 >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
        ],
    )
    with _managed(path) as ex:
        document = raw_document(ex)
    assert document["version"] == "1.7"


class _managed:
    """Tiny context manager around PdfExtractor (keeps tests readable)."""

    def __init__(self, path):
        self._extractor = PdfExtractor(path)

    def __enter__(self):
        return self._extractor

    def __exit__(self, *exc_info):
        self._extractor.close()
        return False


def test_raw_document_version_from_pdf_header(extractor):
    # reportlab writes `%PDF-1.4` (see the sample fixture); pdfplumber exposes
    # no version attribute, so the header is the only source here.
    assert raw_document(extractor)["version"] == "1.4"


def test_raw_document_version_prefers_trailer_over_header(tmp_path):
    path = _write_pdf(
        tmp_path / "trailer-version.pdf",
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
        ],
    )
    # The hand-written helper writes a 1.4 header; an explicit trailer wins.
    path_object = Path(path)
    data = path_object.read_bytes().replace(
        b"trailer\n<< /Size",
        b"trailer\n<< /Version /1.7 /Size",
    )
    path_object.write_bytes(data)
    with _managed(path) as ex:
        assert raw_document(ex)["version"] == "1.7"


def test_raw_document_missing_trailer_roots_are_null(tmp_path):
    path = _write_pdf(
        tmp_path / "minimal.pdf",
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
        ],
    )
    with _managed(path) as ex:
        document = raw_document(ex)

    roots = {root["label"]: root for root in document["roots"]}
    assert roots["Info"] == {"label": "Info", "ref": None, "value": None}
    assert roots["Encrypt"] == {"label": "Encrypt", "ref": None, "value": None}
    assert roots["ID"] == {"label": "ID", "ref": None, "value": None}
    assert roots["Catalog"]["ref"]["objectNumber"] == 1
    assert roots["Pages"]["ref"]["objectNumber"] == 2


# --- raw_object -------------------------------------------------------------


def test_raw_object_serializes_dict_name_string_ref(extractor):
    catalog_ref = next(
        root["ref"] for root in raw_document(extractor)["roots"]
        if root["label"] == "Catalog"
    )
    obj = raw_object(extractor, catalog_ref["objectNumber"], catalog_ref["generation"])

    assert obj["ref"] == catalog_ref
    assert obj["summary"] == "dict (3 entries)"
    value = obj["value"]
    assert value["kind"] == "dict"
    assert _entry(value, "Type") == {"kind": "name", "value": "Catalog"}
    pages = _entry(value, "Pages")
    assert pages["kind"] == "ref"
    assert set(pages) == {"kind", "ref"}
    assert set(pages["ref"]) == {"objectNumber", "generation"}
    assert pages["ref"]["objectNumber"] > 0
    # References are never resolved recursively.

    info_ref = next(
        root["ref"] for root in raw_document(extractor)["roots"]
        if root["label"] == "Info"
    )
    info = raw_object(extractor, info_ref["objectNumber"])
    assert info["summary"].startswith("dict (")
    strings = [
        entry["value"] for entry in info["value"]["entries"]
        if entry["value"]["kind"] == "string"
    ]
    assert strings, "expected at least one PDF string in /Info"
    assert all(set(item) == {"kind", "value", "truncated"} for item in strings)


def test_raw_object_array_of_refs(extractor):
    pages_ref = next(
        root["ref"] for root in raw_document(extractor)["roots"]
        if root["label"] == "Pages"
    )
    pages = raw_object(extractor, pages_ref["objectNumber"])
    kids = _entry(pages["value"], "Kids")

    assert kids["kind"] == "array"
    assert len(kids["items"]) == 2
    children = [item["ref"]["objectNumber"] for item in kids["items"]]
    assert all(number > 0 for number in children)


def test_raw_object_generation_validation(extractor):
    with pytest.raises(RawError, match="generation"):
        raw_object(extractor, 1, generation=99)
    with pytest.raises(RawError, match="object_number"):
        raw_object(extractor, "1")
    with pytest.raises(RawError, match="object_number"):
        raw_object(extractor, 0)
    with pytest.raises(RawError, match="object_number"):
        raw_object(extractor, True)
    with pytest.raises(RawError, match="generation"):
        raw_object(extractor, 1, generation=-1)


def test_raw_object_null_and_scalar_objects():
    fake = _FakeExtractor(_FakeDoc({4: None, 5: 42, 6: b"text", 7: LIT("Name")}))

    null = raw_object(fake, 4)
    assert null["value"] == {"kind": "null"}
    assert null["summary"] == "null"

    number = raw_object(fake, 5)
    assert number["value"] == {"kind": "number", "value": 42}
    assert number["summary"] == "number 42"

    string = raw_object(fake, 6)
    assert string["value"] == {"kind": "string", "value": "text", "truncated": False}
    assert string["summary"] == "string (4 bytes)"

    name = raw_object(fake, 7)
    assert name["value"] == {"kind": "name", "value": "Name"}
    assert name["summary"] == "name Name"


def test_raw_object_reads_explicit_null_from_real_pdf(tmp_path):
    path = _write_pdf(
        tmp_path / "null-object.pdf",
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
            b"null",
        ],
    )
    with _managed(path) as ex:
        obj = raw_object(ex, 4)

    assert obj["value"] == {"kind": "null"}
    assert obj["summary"] == "null"


def test_raw_object_missing_and_malformed_objects(extractor):
    with pytest.raises(RawError, match="not found"):
        raw_object(extractor, 99_999)

    class BrokenDoc(_FakeDoc):
        def getobj(self, object_number):
            raise RuntimeError("cannot parse object")

    fake = _FakeExtractor(BrokenDoc())
    with pytest.raises(RawError, match="Cannot read object 3"):
        raw_object(fake, 3)


def test_raw_object_generation_from_xref_and_stream_metadata():
    stream = PDFStream({}, b"BT ET")
    stream.set_objid(7, 3)
    doc = _FakeDoc({7: stream}, xrefs=[_FakeXRef({7: (None, 0, 3)})])
    fake = _FakeExtractor(doc)

    obj = raw_object(fake, 7, generation=3)
    assert obj["ref"] == {"objectNumber": 7, "generation": 3}
    assert obj["value"]["kind"] == "stream"
    assert obj["summary"] == "stream (5 bytes)"


def test_raw_object_returns_ref_without_resolving_it():
    doc = _FakeDoc({15: PDFObjRef(None, 15)})
    fake = _FakeExtractor(doc)

    obj = raw_object(fake, 15)

    assert obj["value"]["kind"] == "ref"
    assert obj["ref"] == {"objectNumber": 15, "generation": 0}
    assert obj["summary"] == "ref 15 0 R"
    # getobj was only called for object 15, never for the target it points at.
    assert doc.requested == [15]


# --- serializer limits ------------------------------------------------------


def test_serialize_value_covers_every_kind():
    doc = _FakeDoc()
    assert raw.serialize_value(None, doc) == {"kind": "null"}
    assert raw.serialize_value(True, doc) == {"kind": "boolean", "value": True}
    assert raw.serialize_value(12, doc) == {"kind": "number", "value": 12}
    assert raw.serialize_value(-1.5, doc) == {"kind": "number", "value": -1.5}
    assert raw.serialize_value(b"abc", doc) == {
        "kind": "string", "value": "abc", "truncated": False,
    }
    assert raw.serialize_value(LIT("Name"), doc) == {"kind": "name", "value": "Name"}
    assert raw.serialize_value(PDFObjRef(doc, 9), doc) == {
        "kind": "ref", "ref": {"objectNumber": 9, "generation": 0},
    }
    assert raw.serialize_value([1, 2], doc) == {
        "kind": "array",
        "items": [{"kind": "number", "value": 1}, {"kind": "number", "value": 2}],
        "truncated": False,
    }
    assert raw.serialize_value({"A": 1}, doc) == {
        "kind": "dict",
        "entries": [{"key": "A", "value": {"kind": "number", "value": 1}}],
        "truncated": False,
    }


def test_serialize_string_is_capped():
    value = raw.serialize_value(b"x" * (raw.MAX_STRING + 10))

    assert value["kind"] == "string"
    assert len(value["value"]) == raw.MAX_STRING
    assert value["truncated"] is True


def test_serialize_array_and_dict_item_caps():
    array = raw.serialize_value(list(range(raw.MAX_ITEMS + 25)))
    assert array["kind"] == "array"
    assert len(array["items"]) == raw.MAX_ITEMS
    assert array["truncated"] is True

    mapping = {f"key{i}": i for i in range(raw.MAX_ITEMS + 25)}
    dict_value = raw.serialize_value(mapping)
    assert dict_value["kind"] == "dict"
    assert len(dict_value["entries"]) == raw.MAX_ITEMS
    assert dict_value["truncated"] is True


def test_serialize_depth_limit():
    nested = 1
    for _ in range(raw.MAX_DEPTH + 1):
        nested = [nested]

    value = raw.serialize_value(nested)
    for _ in range(raw.MAX_DEPTH):
        assert value["kind"] == "array"
        assert value["truncated"] is False
        value = value["items"][0]

    assert value == {"kind": "array", "items": [], "truncated": True}


def test_serialize_stream_metadata_and_text_preview():
    data = b"BT /F1 12 Tf (Hello) Tj ET"
    stream = PDFStream({}, data)
    stream.set_objid(11, 0)

    value = raw.serialize_value(stream)

    assert value["kind"] == "stream"
    assert value["dict"] == {"kind": "dict", "entries": [], "truncated": False}
    assert value["length"] == len(data)
    assert value["filters"] == []
    assert value["preview"] == data.decode("ascii")
    assert value["truncated"] is False


def test_serialize_stream_binary_has_no_preview():
    stream = PDFStream({}, b"\x00\x01\x02\xff\xfe")
    value = raw.serialize_value(stream)
    assert value["preview"] is None
    assert value["truncated"] is True

    image = PDFStream({"Subtype": LIT("Image")}, b"\x89PNG\r\n\x1a\n")
    image_value = raw.serialize_value(image)
    assert image_value["preview"] is None
    assert image_value["truncated"] is True


def test_serialize_stream_preview_is_capped():
    stream = PDFStream({}, b"A" * (raw.MAX_STRING + 50))
    value = raw.serialize_value(stream)
    assert value["preview"] == "A" * raw.MAX_STRING
    assert value["truncated"] is True


def test_serialize_stream_filters_and_decoded_preview():
    payload = b"BT ET"
    stream = PDFStream({"Filter": LIT("FlateDecode")}, zlib.compress(payload))
    value = raw.serialize_value(stream)

    assert value["filters"] == ["FlateDecode"]
    assert value["preview"] == "BT ET"
    assert value["length"] == len(zlib.compress(payload))


def test_serialize_malformed_stream_does_not_raise():
    value = raw.serialize_value(_ExplodingStream())
    assert value["kind"] == "stream"
    assert value["preview"] is None
    assert value["truncated"] is True
    json.dumps(value)


# --- raw_page_content -------------------------------------------------------


def test_raw_page_content_operators_and_operand_order(extractor):
    result = raw_page_content(extractor, 1)

    assert result["page"] == 1
    assert result["truncated"] is False
    assert len(result["streams"]) >= 1

    stream = result["streams"][0]
    assert stream["error"] is None
    assert stream["ref"]["objectNumber"] > 0
    assert stream["length"] > 0
    assert stream["filters"] == ["ASCII85Decode", "FlateDecode"]
    assert stream["truncated"] is False

    operators = stream["operators"]
    assert [operator["index"] for operator in operators] == list(range(len(operators)))
    assert [operator["offset"] for operator in operators] == sorted(
        operator["offset"] for operator in operators
    )

    names = [operator["operator"] for operator in operators]
    assert "BT" in names
    assert "Tf" in names
    assert "Tj" in names
    assert "Do" in names

    tf = next(operator for operator in operators if operator["operator"] == "Tf")
    assert tf["operands"][0]["kind"] == "name"
    assert tf["operands"][0]["value"]
    assert tf["operands"][1] == {"kind": "number", "value": 12}

    tj = next(operator for operator in operators if operator["operator"] == "Tj")
    assert tj["operands"][0]["kind"] == "string"
    assert "Hello Raw" in tj["operands"][0]["value"]

    serialized = json.dumps(result)
    assert "timestamp" not in serialized


def test_raw_page_content_image_stream_never_exposes_bytes(extractor):
    _object_number, image = _find_image_stream(extractor._pdf.doc)
    assert image is not None, "reportlab image XObject not found"

    obj = raw_object(extractor, image.objid)
    assert obj["value"]["kind"] == "stream"
    assert obj["value"]["preview"] is None
    assert obj["value"]["truncated"] is True
    assert obj["summary"].startswith("stream (")


def test_raw_page_content_rejects_bad_pages(extractor):
    for page in ("1", 1.0, True, None):
        with pytest.raises(RawError, match='"page" must be an integer'):
            raw_page_content(extractor, page)
    for page in (0, -1):
        with pytest.raises(RawError, match='"page" must be at least 1'):
            raw_page_content(extractor, page)
    with pytest.raises(RawError, match="out of range"):
        raw_page_content(extractor, 3)


def test_raw_page_content_multiple_streams_are_indexed_per_page(tmp_path):
    path = _two_stream_pdf(tmp_path)
    with _managed(path) as ex:
        result = raw_page_content(ex, 1)

    assert len(result["streams"]) == 2
    first, second = result["streams"]
    assert [operator["operator"] for operator in first["operators"]] == [
        "BT", "Tf", "Tj", "ET",
    ]
    assert [operator["operator"] for operator in second["operators"]] == ["m", "l", "S"]
    # Indices continue across streams; offsets restart per stream.
    assert second["operators"][0]["index"] == first["operators"][-1]["index"] + 1
    assert first["operators"][0]["offset"] >= 0
    assert second["operators"][0]["offset"] >= 0
    assert [operator["index"] for operator in _operators(result)] == list(
        range(len(_operators(result)))
    )


def test_raw_page_content_truncated_array_tail_is_reported(tmp_path):
    path = _single_content_pdf(tmp_path, b"q [ 1 2 3", "truncated-array.pdf")
    with _managed(path) as ex:
        result = raw_page_content(ex, 1)

    stream = result["streams"][0]
    # The already-parsed operator is kept; the unfinished array is not silent.
    assert [operator["operator"] for operator in stream["operators"]] == ["q"]
    assert "unfinished array" in stream["error"]
    assert stream["truncated"] is True
    assert result["truncated"] is True


def test_raw_page_content_trailing_operands_are_reported(tmp_path):
    path = _single_content_pdf(tmp_path, b"BT 1 2 3", "trailing-operands.pdf")
    with _managed(path) as ex:
        result = raw_page_content(ex, 1)

    stream = result["streams"][0]
    assert [operator["operator"] for operator in stream["operators"]] == ["BT"]
    assert stream["operators"][0]["operands"] == []
    assert stream["error"] == "Stream ended with 3 unparsed operand(s)"
    assert stream["truncated"] is True
    assert result["truncated"] is True


def test_raw_page_content_well_formed_stream_ends_clean(tmp_path):
    path = _single_content_pdf(tmp_path, b"BT /F1 12 Tf", "clean-end.pdf")
    with _managed(path) as ex:
        result = raw_page_content(ex, 1)

    stream = result["streams"][0]
    assert [operator["operator"] for operator in stream["operators"]] == ["BT", "Tf"]
    assert stream["error"] is None
    assert stream["truncated"] is False
    assert result["truncated"] is False


def test_raw_page_content_unreadable_stream_degrades(tmp_path):
    path = _bad_contents_pdf(tmp_path)
    with _managed(path) as ex:
        result = raw_page_content(ex, 1)

    assert len(result["streams"]) == 1
    stream = result["streams"][0]
    assert stream["operators"] == []
    assert "Cannot read stream" in stream["error"]
    assert stream["truncated"] is True
    assert result["truncated"] is True


def test_raw_page_content_undecodable_stream_degrades():
    fake = _FakeExtractor(_FakeDoc(), pages=[_fake_page([_ExplodingStream()])])

    result = raw_page_content(fake, 1)

    stream = result["streams"][0]
    assert stream["operators"] == []
    assert "Cannot decode stream" in stream["error"]
    assert stream["truncated"] is True


def test_raw_page_content_partial_operators_on_parser_failure(monkeypatch):
    class FlakyParser:
        def __init__(self, streams):
            self.tokens = [(0, KWD(b"BT")), (3, 1), (5, KWD(b"Tf"))]

        def nextobject(self):
            if self.tokens:
                return self.tokens.pop(0)
            raise RuntimeError("bad token")

    monkeypatch.setattr(raw, "PDFContentParser", FlakyParser)
    fake = _FakeExtractor(_FakeDoc(), pages=[_fake_page([PDFStream({}, b"")])])

    result = raw_page_content(fake, 1)

    stream = result["streams"][0]
    assert [operator["operator"] for operator in stream["operators"]] == ["BT", "Tf"]
    assert stream["operators"][1]["operands"] == [{"kind": "number", "value": 1}]
    assert "RuntimeError: bad token" in stream["error"]
    assert stream["truncated"] is True
    assert result["truncated"] is True


def test_raw_page_content_operator_cap(monkeypatch):
    class EndlessParser:
        def __init__(self, streams):
            self.position = 0

        def nextobject(self):
            self.position += 1
            if self.position % 2 == 0:
                return (self.position, KWD(b"Tj"))
            return (self.position, 1)

    monkeypatch.setattr(raw, "PDFContentParser", EndlessParser)
    fake = _FakeExtractor(_FakeDoc(), pages=[_fake_page([PDFStream({}, b"")])])

    result = raw_page_content(fake, 1)

    stream = result["streams"][0]
    assert len(stream["operators"]) == raw.MAX_OPERATORS
    assert stream["operators"][-1]["index"] == raw.MAX_OPERATORS - 1
    assert stream["truncated"] is True
    assert result["truncated"] is True


def test_raw_page_content_stream_cap():
    streams = [PDFStream({}, b"") for _ in range(raw.MAX_CONTENT_STREAMS + 3)]
    fake = _FakeExtractor(_FakeDoc(), pages=[_fake_page(streams)])

    result = raw_page_content(fake, 1)

    assert len(result["streams"]) == raw.MAX_CONTENT_STREAMS
    assert result["truncated"] is True


# --- RPC dispatch -----------------------------------------------------------


def test_raw_rpc_requires_an_open_document():
    session = SidecarSession()

    assert session.handle("raw_document", {}, request_id=1) == {
        "id": 1,
        "error": "No PDF open",
    }
    assert session.handle(
        "raw_object", {"object_number": 1}, request_id=2
    ) == {"id": 2, "error": "No PDF open"}
    assert session.handle(
        "raw_page_content", {"page": 1}, request_id=3
    ) == {"id": 3, "error": "No PDF open"}


def test_raw_rpc_dispatch_success(sample_pdf):
    session = SidecarSession()
    assert "error" not in session.handle("open", {"path": sample_pdf}, request_id=1)

    document = session.handle("raw_document", {}, request_id=2)
    assert "error" not in document
    catalog_ref = next(
        root["ref"] for root in document["result"]["roots"]
        if root["label"] == "Catalog"
    )

    obj = session.handle(
        "raw_object",
        {"object_number": catalog_ref["objectNumber"], "generation": 0},
        request_id=3,
    )
    assert "error" not in obj
    assert obj["result"]["summary"].startswith("dict (")

    content = session.handle("raw_page_content", {"page": 1}, request_id=4)
    assert "error" not in content
    assert content["result"]["page"] == 1
    assert "BT" in [operator["operator"] for operator in _operators(content["result"])]


def test_raw_rpc_invalid_arguments_are_clean_errors(sample_pdf):
    session = SidecarSession()
    assert "error" not in session.handle("open", {"path": sample_pdf}, request_id=1)

    missing = session.handle("raw_object", {}, request_id=2)
    assert missing == {"id": 2, "error": '"object_number" must be an integer'}

    bad_type = session.handle(
        "raw_object", {"object_number": "7"}, request_id=3
    )
    assert bad_type["error"] == '"object_number" must be an integer'

    bad_range = session.handle("raw_object", {"object_number": 0}, request_id=4)
    assert bad_range["error"] == '"object_number" must be at least 1'

    missing_object = session.handle("raw_object", {"object_number": 99_999}, request_id=5)
    assert missing_object["error"] == "Object 99999 not found"

    bad_generation = session.handle(
        "raw_object", {"object_number": 1, "generation": 99}, request_id=6
    )
    assert "generation" in bad_generation["error"]

    page_range = session.handle("raw_page_content", {"page": 3}, request_id=7)
    assert "out of range" in page_range["error"]

    page_type = session.handle("raw_page_content", {"page": "1"}, request_id=8)
    assert page_type["error"] == '"page" must be an integer'

    for response in (
        missing_object, bad_generation, page_range, page_type,
    ):
        assert "Traceback" not in response["error"]
