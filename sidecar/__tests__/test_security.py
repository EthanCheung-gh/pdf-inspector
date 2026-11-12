"""Document security resources: attachments, JavaScript, actions, signatures, encryption.

Real minimal PDFs pin the structures the collector walks (name trees, page
annotations, /AcroForm fields and xref trailers); fake extractors and streams
pin the failure paths a real PDF cannot produce on demand (oversized declared
sizes, exploding catalogs, malformed ByteRange values).
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest
from reportlab.lib import pdfencrypt
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import audit  # noqa: E402
import security  # noqa: E402
from audit import audit_document, audit_file, security_findings, security_report  # noqa: E402
from diff import TOOL_NAME, tool_version  # noqa: E402
from extractor import PdfExtractor  # noqa: E402

RESOURCE_KEYS = {
    "document",
    "attachments",
    "javascript",
    "actions",
    "signatures",
    "encryption",
}
DOCUMENT_KEYS = {
    "pages",
    "version",
    "encrypted",
    "xfa",
    "hasMetadata",
    "outputIntents",
}
REPORT_KEYS = RESOURCE_KEYS | {"schemaVersion", "tool", "findings", "summary"}


# --- PDF fixture helpers ----------------------------------------------------


def _stream(data: bytes, attrs: bytes = b"") -> bytes:
    return b"<< /Length %d " % len(data) + attrs + b" >>\nstream\n" + data + b"\nendstream"


def _string(text: str) -> bytes:
    """A PDF literal string with parentheses/backslashes escaped."""
    data = text.encode("utf-8")
    data = data.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    return b"(" + data + b")"


def _write_pdf(path: Path, objects: list[bytes], trailer_extra: bytes = b"") -> str:
    """Write a minimal PDF with numbered objects (1-based, uncompressed)."""
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
    out += (
        b"trailer\n<< /Size %d /Root 1 0 R " % (len(objects) + 1)
        + trailer_extra
        + b">>\nstartxref\n%d\n%%%%EOF\n" % xref_position
    )
    path.write_bytes(bytes(out))
    return str(path)


def _page_pdf(
    path: Path,
    catalog_extra: bytes = b"",
    page_extra: bytes = b"",
    extra_objects: list[bytes] = (),
) -> str:
    """One-page PDF; extra objects are numbered from 5 onwards."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R " + catalog_extra + b" >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        + page_extra
        + b" >>",
        _stream(b""),
    ] + list(extra_objects)
    return _write_pdf(path, objects)


def _collect(path) -> dict:
    extractor = PdfExtractor(str(path))
    try:
        return security.collect_security(extractor)
    finally:
        extractor.close()


def _collect_meta(path) -> tuple[dict, dict]:
    extractor = PdfExtractor(str(path))
    try:
        return security.collect_security_with_meta(extractor)
    finally:
        extractor.close()


def _audit(path) -> dict:
    extractor = PdfExtractor(str(path))
    try:
        return audit_document(extractor)
    finally:
        extractor.close()


def _security_report(path) -> dict:
    extractor = PdfExtractor(str(path))
    try:
        return security_report(extractor)
    finally:
        extractor.close()


def _attachment_pdf(path: Path) -> str:
    """Two attachments under one /Kids root: a text file and an executable."""
    return _page_pdf(
        path,
        catalog_extra=b"/Names << /EmbeddedFiles 5 0 R >>",
        extra_objects=[
            b"<< /Kids [6 0 R 7 0 R] >>",
            b"<< /Limits [(a.txt) (a.txt)] /Names [(a.txt) 8 0 R] >>",
            b"<< /Names [(run.exe) 9 0 R] >>",
            b"<< /Type /Filespec /UF (a.txt) /F (a.txt) /Desc (A text file)"
            b" /EF << /F 10 0 R >> >>",
            b"<< /Type /Filespec /F (run.exe) /EF << /F 11 0 R >> >>",
            _stream(
                b"hello",
                b"/Type /EmbeddedFile /Subtype /text#2Fplain"
                b" /Params << /Size 5 /ModDate (D:20200101000000Z) >>",
            ),
            _stream(
                b"MZ..",
                b"/Type /EmbeddedFile /Subtype /application#2Foctet-stream"
                b" /Params << /Size 4 >>",
            ),
        ],
    )


def _javascript_pdf(path: Path) -> str:
    """JavaScript in every supported location plus a URI/SubmitForm action."""
    return _page_pdf(
        path,
        catalog_extra=b"/Names << /JavaScript 5 0 R >> /OpenAction 7 0 R"
        b" /AA << /WC 8 0 R >>",
        page_extra=b"/AA << /O 9 0 R >> /Annots [10 0 R 11 0 R]",
        extra_objects=[
            b"<< /Names [(init) 6 0 R] >>",
            b"<< /S /JavaScript /JS (app.alert\\(1\\)) >>",
            b"<< /S /JavaScript /JS (open) >>",
            b"<< /S /JavaScript /JS (auto) >>",
            b"<< /S /JavaScript /JS (page) >>",
            b"<< /Type /Annot /Subtype /Link /NM (LinkNote)"
            b" /A << /S /URI /URI (https://example.com/x) >>"
            b" /AA << /E 12 0 R >> >>",
            b"<< /Type /Annot /Subtype /Link /A << /S /JavaScript /JS (annot) >> >>",
            b"<< /S /SubmitForm /F (https://example.com/post) >>",
        ],
    )


def _signature_pdf(path: Path) -> str:
    """XFA plus one signed signature field pointing at /P 3 0 R."""
    return _page_pdf(
        path,
        catalog_extra=b"/AcroForm 5 0 R",
        extra_objects=[
            b"<< /XFA 6 0 R /Fields [7 0 R] >>",
            _stream(b"<xdp:xdp/>"),
            b"<< /FT /Sig /T (Signature1) /V 8 0 R /P 3 0 R >>",
            b"<< /Type /Sig /Name (Alice) /M (D:20240101000000Z)"
            b" /Reason (Approval) /Location (Berlin)"
            b" /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 120 80] >>",
        ],
    )


def _rich_pdf(path: Path) -> str:
    """An executable attachment, an XFA marker and one signature field."""
    return _page_pdf(
        path,
        catalog_extra=b"/Names << /EmbeddedFiles 5 0 R >> /AcroForm 9 0 R",
        extra_objects=[
            b"<< /Names [(evil.exe) 6 0 R] >>",
            b"<< /Type /Filespec /F (evil.exe) /EF << /F 7 0 R >> >>",
            _stream(
                b"MZ..",
                b"/Type /EmbeddedFile /Subtype /application#2Foctet-stream"
                b" /Params << /Size 4 >>",
            ),
            _stream(b"<xdp:xdp/>"),
            b"<< /XFA 8 0 R /Fields [10 0 R] >>",
            b"<< /FT /Sig /T (Sig1) /V 11 0 R >>",
            b"<< /Type /Sig /Name (Alice) /ByteRange [0 10 20 10] >>",
        ],
    )


# --- fake extractors --------------------------------------------------------


class _ExplodingMapping(dict):
    def get(self, key, default=None):
        raise RuntimeError("broken catalog entry")


class _BrokenRef:
    def resolve(self):
        raise RuntimeError("broken object reference")


class _FakeDoc:
    def __init__(self, catalog=None, encryption=None, xrefs=None):
        self.catalog = catalog if catalog is not None else {}
        self.encryption = encryption
        self._xrefs = xrefs

    @property
    def xrefs(self):
        if isinstance(self._xrefs, Exception):
            raise self._xrefs
        return self._xrefs if self._xrefs is not None else []


class _FakePdf:
    def __init__(self, pages=(), doc=None, version=None):
        self.pages = list(pages)
        self.doc = doc if doc is not None else _FakeDoc()
        self.pdf_version = version

    @property
    def is_encrypted(self):
        return bool(self.doc.encryption)


class _FakeExtractor:
    def __init__(self, pages=(), catalog=None, encryption=None, xrefs=None, version=None):
        self._pdf = _FakePdf(
            pages=pages,
            doc=_FakeDoc(catalog, encryption, xrefs),
            version=version,
        )

    def get_metadata(self):
        return {"pages": len(self._pdf.pages)}


class _FakeStream:
    def __init__(self, data=b"data", length=None, params_size=None):
        self.attrs = {}
        if length is not None:
            self.attrs["Length"] = length
        if params_size is not None:
            self.attrs["Params"] = {"Size": params_size}
        self.data = data
        self.calls = 0

    def get_data(self):
        self.calls += 1
        return self.data


# --- contract ---------------------------------------------------------------


def test_collect_security_returns_exactly_the_contract_blocks(tmp_path):
    resources = _collect(_page_pdf(tmp_path / "plain.pdf"))

    assert set(resources) == RESOURCE_KEYS
    assert set(resources["document"]) == DOCUMENT_KEYS
    assert resources["document"]["pages"] == 1
    assert resources["document"]["version"] == "1.4"
    assert resources["document"]["encrypted"] is False
    assert resources["document"]["xfa"] is False
    assert resources["document"]["hasMetadata"] is False
    assert resources["document"]["outputIntents"] == 0
    assert resources["attachments"] == []
    assert resources["javascript"] == []
    assert resources["actions"] == []
    assert resources["signatures"] == []
    assert resources["encryption"] is None
    json.dumps(resources)


def test_document_metadata_and_output_intents_are_counted(tmp_path):
    path = _page_pdf(
        tmp_path / "metadata.pdf",
        catalog_extra=b"/Metadata 5 0 R /OutputIntents [6 0 R 7 0 R]",
        extra_objects=[
            _stream(b"<x:xmpmeta/>", b"/Type /Metadata /Subtype /XML"),
            b"<< /Type /OutputIntent /S /GTS_PDFA1 >>",
            b"<< /Type /OutputIntent /S /GTS_PDFA1 >>",
        ],
    )

    document = _collect(path)["document"]

    assert document["hasMetadata"] is True
    assert document["outputIntents"] == 2


def test_collect_security_is_deterministic_and_free_of_paths(tmp_path):
    path = _javascript_pdf(tmp_path / "deterministic.pdf")

    first = _collect(path)
    second = _collect(path)
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)

    payload = json.dumps(first)
    assert str(tmp_path) not in payload
    assert path not in payload
    assert not re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", payload)


# --- attachments ------------------------------------------------------------


def test_name_tree_kids_and_names_are_both_walked(tmp_path):
    attachments = _collect(_attachment_pdf(tmp_path / "attachments.pdf"))["attachments"]

    assert [a["name"] for a in attachments] == ["a.txt", "run.exe"]
    text_file, executable = attachments

    assert text_file == {
        "name": "a.txt",
        "description": "A text file",
        "size": 5,
        "mimeType": "text/plain",
        "modified": "D:20200101000000Z",
        "sha256": hashlib.sha256(b"hello").hexdigest(),
        "risky": False,
    }
    assert executable["name"] == "run.exe"
    assert executable["description"] is None
    assert executable["size"] == 4
    assert executable["mimeType"] == "application/octet-stream"
    assert executable["modified"] is None
    assert executable["sha256"] == hashlib.sha256(b"MZ..").hexdigest()
    assert executable["risky"] is True


def test_name_tree_cycles_and_missing_references_are_skipped(tmp_path):
    path = _page_pdf(
        tmp_path / "cycle.pdf",
        catalog_extra=b"/Names << /EmbeddedFiles 5 0 R >>",
        extra_objects=[
            b"<< /Kids [5 0 R 6 0 R 99 0 R] >>",
            b"<< /Names [(safe.txt) 7 0 R] >>",
            b"<< /Type /Filespec /UF (safe.txt) /EF << /F 8 0 R >> >>",
            _stream(b"ok", b"/Type /EmbeddedFile /Length 2"),
        ],
    )

    attachments = _collect(path)["attachments"]

    assert [a["name"] for a in attachments] == ["safe.txt"]


def test_name_tree_depth_is_bounded(tmp_path):
    # Nodes 5..13 form a chain deeper than MAX_NAME_TREE_DEPTH; the entry lives
    # in node 13, which is never expanded.
    objects = [b"<< /Kids [%d 0 R] >>" % (number + 1) for number in range(5, 13)]
    objects.append(b"<< /Names [(deep.txt) 14 0 R] >>")
    objects.append(b"<< /Type /Filespec /UF (deep.txt) /EF << /F 99 0 R >> >>")
    path = _page_pdf(
        tmp_path / "deep.pdf",
        catalog_extra=b"/Names << /EmbeddedFiles 5 0 R >>",
        extra_objects=objects,
    )

    resources, truncation = _collect_meta(path)
    assert resources["attachments"] == []
    assert truncation["attachmentSections"] == 1


def test_name_tree_empty_deep_kids_do_not_report_truncation():
    deep = {}
    for _ in range(9):
        deep = {"Kids": [deep]}
    extractor = _FakeExtractor(
        catalog={
            "Names": {
                "EmbeddedFiles": deep,
                "JavaScript": deep,
            }
        }
    )

    resources, truncation = security.collect_security_with_meta(extractor)

    assert resources["attachments"] == []
    assert resources["javascript"] == []
    assert not truncation
    titles = {finding["title"] for finding in audit.security_findings(resources, truncation)}
    assert "Attachment listing truncated" not in titles
    assert "JavaScript listing truncated" not in titles


def test_attachment_size_prefers_positive_params_size(tmp_path):
    path = _page_pdf(
        tmp_path / "params-size.pdf",
        catalog_extra=b"/Names << /EmbeddedFiles 5 0 R >>",
        extra_objects=[
            b"<< /Names [(data.bin) 6 0 R] >>",
            b"<< /Type /Filespec /UF (data.bin) /EF << /F 7 0 R >> >>",
            _stream(
                b"hello",
                b"/Type /EmbeddedFile /Length 5 /Params << /Size 3 >>",
            ),
        ],
    )

    attachment = _collect(path)["attachments"][0]

    assert attachment["size"] == 3


def test_attachment_size_falls_back_to_stream_length(tmp_path):
    path = _page_pdf(
        tmp_path / "length-size.pdf",
        catalog_extra=b"/Names << /EmbeddedFiles 5 0 R >>",
        extra_objects=[
            b"<< /Names [(data.bin) 6 0 R] >>",
            b"<< /Type /Filespec /UF (data.bin) /EF << /F 7 0 R >> >>",
            _stream(
                b"hello",
                b"/Type /EmbeddedFile /Length 5 /Params << /Size 0 >>",
            ),
        ],
    )

    assert _collect(path)["attachments"][0]["size"] == 5


def test_missing_attachment_stream_degrades_to_metadata(tmp_path):
    path = _page_pdf(
        tmp_path / "missing-stream.pdf",
        catalog_extra=b"/Names << /EmbeddedFiles 5 0 R >>",
        extra_objects=[
            b"<< /Names [(ghost.txt) 6 0 R] >>",
            b"<< /Type /Filespec /UF (ghost.txt) /EF << /F 99 0 R >> >>",
        ],
    )

    attachment = _collect(path)["attachments"][0]

    assert attachment["name"] == "ghost.txt"
    assert attachment["size"] is None
    assert attachment["mimeType"] is None
    assert attachment["sha256"] is None


@pytest.mark.parametrize(
    "name, risky",
    [
        ("report.pdf", False),
        ("README", False),
        ("setup.exe", True),
        ("script.JS", True),
        ("run.bat", True),
        ("a/b.pdf", True),
        ("a\\b.pdf", True),
        ("../escape.pdf", True),
        ("archive.tar.gz", False),
    ],
)
def test_risky_attachment_names(name, risky):
    assert security._risky_name(name) is risky


def test_attachment_hash_is_skipped_above_the_size_limit():
    limit = security.MAX_ATTACHMENT_HASH_BYTES
    oversized_data = _FakeStream(b"data", length=limit + 1)
    oversized_params = _FakeStream(b"data", length=4, params_size=limit + 1)
    missing_size = _FakeStream(b"data", length=None)

    assert security._attachment_hash(oversized_data, limit + 1, None) is None
    assert security._attachment_hash(oversized_params, 4, limit + 1) is None
    assert security._attachment_hash(missing_size, None, None) is None
    assert oversized_data.calls == 0
    assert oversized_params.calls == 0
    assert missing_size.calls == 0


def test_attachment_hash_hashes_only_when_declared_sizes_are_small():
    stream = _FakeStream(b"hello", length=5, params_size=5)

    digest = security._attachment_hash(stream, 5, 5)

    assert digest == hashlib.sha256(b"hello").hexdigest()
    assert stream.calls == 1


def test_javascript_stream_preview_is_bounded_by_declared_length():
    class _OversizedScript:
        attrs = {"Length": security.MAX_SCRIPT_BYTES + 1}

        def get_data(self):
            raise AssertionError("an oversized script stream must not be decoded")

    source, truncated = security._javascript_source({"JS": _OversizedScript()})

    assert source == ""
    assert truncated is True


def test_attachment_javascript_action_and_signature_limits_are_enforced():
    entries = [
        [("k%d" % index), {"S": "JavaScript", "JS": "x"}]
        for index in range(security.MAX_ATTACHMENTS + 20)
    ]
    names = {"JavaScript": {"Names": [item for pair in entries for item in pair]}}
    filespecs = [
        [("f%d" % index), {"Type": "Filespec", "F": "f%d" % index}]
        for index in range(security.MAX_ATTACHMENTS + 20)
    ]
    names["EmbeddedFiles"] = {
        "Names": [item for pair in filespecs for item in pair]
    }
    triggers = {
        "T%d" % index: {"S": "URI", "URI": "https://example.com/%d" % index}
        for index in range(security.MAX_ACTIONS + 20)
    }
    fields = [
        {"FT": "Sig", "T": "Sig%d" % index}
        for index in range(security.MAX_SIGNATURES + 20)
    ]
    extractor = _FakeExtractor(
        catalog={
            "Names": names,
            "AA": triggers,
            "AcroForm": {"Fields": fields},
        }
    )

    resources, truncation = security.collect_security_with_meta(extractor)

    assert len(resources["attachments"]) == security.MAX_ATTACHMENTS
    assert len(resources["javascript"]) == security.MAX_JAVASCRIPT_ENTRIES
    assert len(resources["actions"]) == security.MAX_ACTIONS
    assert len(resources["signatures"]) == security.MAX_SIGNATURES
    assert truncation["attachments"] == 1
    assert truncation["javascript"] == 20
    assert truncation["actions"] == 140
    assert truncation.get("riskyActions", 0) == 0
    assert truncation["signatures"] == 20

    titles = {
        finding["title"]
        for finding in audit.security_findings(resources, truncation)
    }
    assert {
        "Action listing truncated",
        "JavaScript listing truncated",
        "Attachment listing truncated",
        "Signature listing truncated",
    } <= titles


def test_action_cap_still_collects_javascript_and_reports_risky_skips():
    triggers = {
        "T%03d" % index: {"S": "URI", "URI": "https://example.com/%d" % index}
        for index in range(security.MAX_ACTIONS)
    }
    triggers["z_js"] = {"S": "JavaScript", "JS": "app.alert(2)"}
    triggers["zz_launch"] = {"S": "Launch", "F": "calc.exe"}
    extractor = _FakeExtractor(catalog={"AA": triggers})

    resources, truncation = security.collect_security_with_meta(extractor)

    assert len(resources["actions"]) == security.MAX_ACTIONS
    assert [entry["source"] for entry in resources["javascript"]] == ["app.alert(2)"]
    assert truncation["actions"] == 2
    assert truncation["riskyActions"] == 2

    findings = audit.security_findings(resources, truncation)
    by_title = {finding["title"]: finding for finding in findings}
    assert "Document contains JavaScript" in by_title
    assert "Action listing truncated" in by_title
    assert "2 of them are risky" in by_title["Action listing truncated"]["detail"]


def test_page_annotation_overflow_still_scans_form_aa_javascript():
    annots = [
        {"Subtype": "Link", "A": {"S": "URI", "URI": "https://example.com/%d" % index}}
        for index in range(security.MAX_ACTIONS + 1)
    ]
    field = {
        "FT": "Tx",
        "T": "Field",
        "AA": {
            "F": {"S": "Launch", "F": "calc.exe"},
            "K": {"S": "JavaScript", "JS": "field-js"},
        },
    }
    extractor = _FakeExtractor(
        pages=[{"Annots": annots}],
        catalog={"AcroForm": {"Fields": [field]}},
    )

    resources, truncation = security.collect_security_with_meta(extractor)

    assert len(resources["actions"]) == security.MAX_ACTIONS
    assert [entry["source"] for entry in resources["javascript"]] == ["field-js"]
    assert truncation["actions"] == 3
    assert truncation["riskyActions"] == 2

    by_title = {
        finding["title"]: finding
        for finding in audit.security_findings(resources, truncation)
    }
    assert "Document contains JavaScript" in by_title
    assert "Action listing truncated" in by_title
    assert "2 of them are risky" in by_title["Action listing truncated"]["detail"]


def test_exact_capacity_does_not_report_truncation():
    triggers = {
        "T%03d" % index: {"S": "URI", "URI": "https://example.com/%d" % index}
        for index in range(security.MAX_ACTIONS - 1)
    }
    triggers["z_launch"] = {"S": "Launch", "F": "calc.exe"}
    action_extractor = _FakeExtractor(catalog={"AA": triggers})
    actions, action_truncation = security.collect_security_with_meta(action_extractor)
    assert len(actions["actions"]) == security.MAX_ACTIONS
    assert not action_truncation
    assert "Launch action" in {
        finding["title"] for finding in audit.security_findings(actions)
    }

    js_pairs = [
        [("k%d" % index), {"S": "JavaScript", "JS": "x"}]
        for index in range(security.MAX_JAVASCRIPT_ENTRIES)
    ]
    js_extractor = _FakeExtractor(
        catalog={
            "Names": {
                "JavaScript": {
                    "Names": [item for pair in js_pairs for item in pair]
                }
            }
        }
    )
    js_resources, js_truncation = security.collect_security_with_meta(js_extractor)
    assert len(js_resources["javascript"]) == security.MAX_JAVASCRIPT_ENTRIES
    assert js_truncation.get("javascript", 0) == 0

    attachment_pairs = [
        [("f%d" % index), {"Type": "Filespec", "F": "f%d" % index}]
        for index in range(security.MAX_ATTACHMENTS)
    ]
    attachment_extractor = _FakeExtractor(
        catalog={
            "Names": {
                "EmbeddedFiles": {
                    "Names": [item for pair in attachment_pairs for item in pair]
                }
            }
        }
    )
    attachments, attachment_truncation = security.collect_security_with_meta(
        attachment_extractor
    )
    assert len(attachments["attachments"]) == security.MAX_ATTACHMENTS
    assert attachment_truncation.get("attachments", 0) == 0

    fields = [
        {"FT": "Sig", "T": "Sig%d" % index}
        for index in range(security.MAX_SIGNATURES)
    ]
    field_extractor = _FakeExtractor(
        catalog={"AcroForm": {"Fields": fields}}
    )
    signatures, signature_truncation = security.collect_security_with_meta(
        field_extractor
    )
    assert len(signatures["signatures"]) == security.MAX_SIGNATURES
    assert signature_truncation.get("signatures", 0) == 0
    assert signature_truncation.get("formFields", 0) == 0

    form_fields = [
        {"FT": "Tx", "T": "Field%d" % index}
        for index in range(security.MAX_FORM_FIELDS)
    ]
    form_extractor = _FakeExtractor(
        catalog={"AcroForm": {"Fields": form_fields}}
    )
    form_resources, form_truncation = security.collect_security_with_meta(
        form_extractor
    )
    assert form_truncation.get("formFields", 0) == 0

    for resources, truncation in (
        (actions, action_truncation),
        (js_resources, js_truncation),
        (attachments, attachment_truncation),
        (signatures, signature_truncation),
        (form_resources, form_truncation),
    ):
        titles = [finding["title"] for finding in audit.security_findings(resources, truncation)]
        assert not any("truncated" in title.lower() for title in titles)


def test_max_form_fields_truncation_is_surfaced():
    fields = [
        {"FT": "Tx", "T": "Field%d" % index}
        for index in range(security.MAX_FORM_FIELDS + 1)
    ]
    extractor = _FakeExtractor(catalog={"AcroForm": {"Fields": fields}})

    resources, truncation = security.collect_security_with_meta(extractor)

    assert truncation["formFields"] == 1
    findings = audit.security_findings(resources, truncation)
    assert "Form field traversal truncated" in {
        finding["title"] for finding in findings
    }


def test_broken_references_that_raise_degrade_without_failing():
    extractor = _FakeExtractor(
        catalog={
            "Names": _BrokenRef(),
            "AcroForm": _BrokenRef(),
            "OpenAction": _BrokenRef(),
            "AA": _BrokenRef(),
            "Metadata": _BrokenRef(),
            "OutputIntents": _BrokenRef(),
        }
    )

    resources, truncation = security.collect_security_with_meta(extractor)

    assert resources["document"]["hasMetadata"] is False
    assert resources["document"]["outputIntents"] == 0
    assert resources["document"]["xfa"] is False
    assert resources["attachments"] == []
    assert resources["javascript"] == []
    assert resources["actions"] == []
    assert resources["signatures"] == []
    assert not any(truncation.values())


def test_security_report_and_audit_document_use_truncation_meta():
    triggers = {
        "T%03d" % index: {"S": "URI", "URI": "https://example.com/%d" % index}
        for index in range(security.MAX_ACTIONS)
    }
    triggers["z_js"] = {"S": "JavaScript", "JS": "app.alert(2)"}
    extractor = _FakeExtractor(catalog={"AA": triggers})

    report = audit.security_report(extractor)
    report_titles = {finding["title"] for finding in report["findings"]}
    assert "Action listing truncated" in report_titles
    assert "Document contains JavaScript" in report_titles
    assert report["summary"]["warnings"] >= 1

    audit_titles = {
        finding["title"] for finding in audit_document(extractor)["findings"]
    }
    assert "Action listing truncated" in audit_titles
    assert "Document contains JavaScript" in audit_titles


def test_missing_pdf_degrades_to_defaults():
    resources = security.collect_security(object())

    assert resources["document"]["pages"] == 0
    assert resources["attachments"] == []
    assert resources["encryption"] is None


# --- JavaScript and actions -------------------------------------------------


def test_javascript_is_collected_from_every_location(tmp_path):
    resources = _collect(_javascript_pdf(tmp_path / "javascript.pdf"))
    javascript = resources["javascript"]

    assert [entry["location"] for entry in javascript] == [
        "Names",
        "OpenAction",
        "AA",
        "Page 1",
        "Annotation 2",
    ]
    assert javascript[0]["name"] == "init"
    assert javascript[0]["page"] is None
    assert javascript[0]["source"] == "app.alert(1)"
    assert javascript[0]["truncated"] is False
    assert javascript[3]["page"] == 1
    assert javascript[4]["source"] == "annot"


def test_javascript_source_is_truncated_at_4096_characters(tmp_path):
    source = "A" * 5000
    path = _page_pdf(
        tmp_path / "long-script.pdf",
        catalog_extra=b"/OpenAction 5 0 R",
        extra_objects=[b"<< /S /JavaScript /JS " + _string(source) + b" >>"],
    )

    entry = _collect(path)["javascript"][0]

    assert len(entry["source"]) == security.MAX_SCRIPT_PREVIEW == 4096
    assert entry["source"] == "A" * 4096
    assert entry["truncated"] is True


def test_action_subtypes_targets_and_risk(tmp_path):
    path = _page_pdf(
        tmp_path / "actions.pdf",
        catalog_extra=b"/OpenAction 5 0 R /AA << /WC 6 0 R /WS 7 0 R >>",
        page_extra=b"/AA << /O 8 0 R >>",
        extra_objects=[
            b"<< /S /Launch /F (calc.exe) >>",
            b"<< /S /Named /N /Print >>",
            b"<< /S /GoTo /D (Chapter1) >>",
            b"<< /S /URI /URI (https://example.com/open) >>",
        ],
    )

    actions = _collect(path)["actions"]
    by_subtype = {action["subtype"]: action for action in actions}

    assert by_subtype["Launch"] == {
        "location": "OpenAction",
        "page": None,
        "subtype": "Launch",
        "target": "calc.exe",
        "risky": True,
    }
    assert by_subtype["Named"]["target"] == "Print"
    assert by_subtype["Named"]["risky"] is False
    assert by_subtype["GoTo"]["target"] == "Chapter1"
    assert by_subtype["GoTo"]["risky"] is False
    assert by_subtype["URI"]["target"] == "https://example.com/open"
    assert by_subtype["URI"]["page"] == 1
    assert by_subtype["URI"]["risky"] is False


def test_javascript_actions_are_marked_risky(tmp_path):
    actions = _collect(_javascript_pdf(tmp_path / "js-actions.pdf"))["actions"]
    javascript = [action for action in actions if action["subtype"] == "JavaScript"]
    submit = [action for action in actions if action["subtype"] == "SubmitForm"]

    assert javascript
    assert all(action["risky"] is True for action in javascript)
    assert submit == [
        {
            "location": "Annotation 1 AA",
            "page": 1,
            "subtype": "SubmitForm",
            "target": "https://example.com/post",
            "risky": True,
        }
    ]


def test_field_aa_javascript_is_collected(tmp_path):
    path = _page_pdf(
        tmp_path / "field-aa.pdf",
        catalog_extra=b"/AcroForm 5 0 R",
        extra_objects=[
            b"<< /Fields [6 0 R] >>",
            b"<< /FT /Tx /T (Name) /P 3 0 R /AA << /K 7 0 R >> >>",
            b"<< /S /JavaScript /JS (field) >>",
        ],
    )

    resources = _collect(path)

    assert resources["javascript"] == [
        {
            "name": "Name",
            "location": "Field Name AA",
            "page": 1,
            "source": "field",
            "truncated": False,
        }
    ]
    assert resources["actions"] == [
        {
            "location": "Field Name AA",
            "page": 1,
            "subtype": "JavaScript",
            "target": None,
            "risky": True,
        }
    ]


def test_stream_javascript_preview_is_read(tmp_path):
    path = _page_pdf(
        tmp_path / "stream-js.pdf",
        catalog_extra=b"/OpenAction 5 0 R",
        extra_objects=[
            b"<< /S /JavaScript /JS 6 0 R >>",
            _stream(b"app.alert(2)"),
        ],
    )

    entry = _collect(path)["javascript"][0]

    assert entry["source"] == "app.alert(2)"
    assert entry["truncated"] is False


def test_javascript_stream_without_length_uses_rawdata_bound():
    class _NoLengthScript:
        attrs = {}

        def get_rawdata(self):
            return b"x" * (security.MAX_SCRIPT_BYTES + 1)

        def get_data(self):
            raise AssertionError("an oversized raw script must not be decoded")

    source, truncated = security._javascript_source({"JS": _NoLengthScript()})

    assert source == ""
    assert truncated is True


def test_javascript_truncation_requires_a_readable_omitted_source():
    sourced = {"S": "JavaScript", "JS": "x"}
    sourced_pairs = [
        item
        for index in range(security.MAX_JAVASCRIPT_ENTRIES)
        for item in ("k%d" % index, sourced)
    ]
    sourceless_extractor = _FakeExtractor(
        catalog={
            "Names": {
                "JavaScript": {
                    "Names": sourced_pairs + ["extra", {"S": "JavaScript"}]
                }
            }
        }
    )
    sourceless_resources, sourceless_truncation = (
        security.collect_security_with_meta(sourceless_extractor)
    )
    assert len(sourceless_resources["javascript"]) == security.MAX_JAVASCRIPT_ENTRIES
    assert "javascript" not in sourceless_truncation
    sourceless_titles = {
        finding["title"]
        for finding in audit.security_findings(
            sourceless_resources, sourceless_truncation
        )
    }
    assert "JavaScript listing truncated" not in sourceless_titles

    readable_extractor = _FakeExtractor(
        catalog={
            "Names": {
                "JavaScript": {
                    "Names": sourced_pairs + ["extra", sourced]
                }
            }
        }
    )
    readable_resources, readable_truncation = security.collect_security_with_meta(
        readable_extractor
    )
    assert len(readable_resources["javascript"]) == security.MAX_JAVASCRIPT_ENTRIES
    assert readable_truncation["javascript"] == 1
    readable_titles = {
        finding["title"]
        for finding in audit.security_findings(
            readable_resources, readable_truncation
        )
    }
    assert "JavaScript listing truncated" in readable_titles


# --- XFA and signatures -----------------------------------------------------


def test_xfa_and_signature_fields_are_reported_unverified(tmp_path):
    resources = _collect(_signature_pdf(tmp_path / "signature.pdf"))

    assert resources["document"]["xfa"] is True
    assert resources["signatures"] == [
        {
            "fieldName": "Signature1",
            "page": 1,
            "signer": "Alice",
            "signedAt": "D:20240101000000Z",
            "reason": "Approval",
            "location": "Berlin",
            "subFilter": "adbe.pkcs7.detached",
            "byteRangeValid": True,
            "verified": False,
        }
    ]


def test_xfa_is_absent_without_an_acroform(tmp_path):
    assert _collect(_page_pdf(tmp_path / "no-xfa.pdf"))["document"]["xfa"] is False


def test_nested_signature_field_maps_its_widget_page(tmp_path):
    path = _page_pdf(
        tmp_path / "nested-signature.pdf",
        catalog_extra=b"/AcroForm 5 0 R",
        extra_objects=[
            b"<< /Fields [6 0 R] >>",
            b"<< /FT /Sig /T (Nested) /V 7 0 R /Kids [8 0 R] >>",
            b"<< /Type /Sig /ByteRange [0 10 20 10] >>",
            b"<< /Type /Annot /Subtype /Widget /P 3 0 R >>",
        ],
    )

    signatures = _collect(path)["signatures"]

    assert len(signatures) == 1
    assert signatures[0]["fieldName"] == "Nested"
    assert signatures[0]["page"] == 1
    assert signatures[0]["verified"] is False


@pytest.mark.parametrize(
    "value, expected",
    [
        (None, None),
        ([0, 10, 20, 10], True),
        ([0, 10, 10, 0], True),
        ([0, 0, 0, 0], False),
        ([0, 0, 20, 10], False),
        ([0, 10, 5, 10], False),
        ([0, 10, 20], False),
        ([-1, 10, 20, 10], False),
        ([0, 10, 20, "x"], False),
        ([10, 10, 20, 10], False),
        ("not-a-byte-range", False),
    ],
)
def test_byte_range_structure(value, expected):
    assert security._byte_range_valid(value) is expected


# --- encryption -------------------------------------------------------------


def _encrypted_pdf(path: Path) -> str:
    encryption = pdfencrypt.StandardEncryption(
        "", "owner", canPrint=1, canModify=0, canCopy=0, canAnnotate=0, strength=128
    )
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, encrypt=encryption)
    canvas.setFont("Helvetica", 12)
    canvas.drawString(72, 720, "secret")
    canvas.save()
    return str(path)


def test_encryption_and_permission_bits_are_reported(tmp_path):
    resources = _collect(_encrypted_pdf(tmp_path / "encrypted.pdf"))
    encryption = resources["encryption"]

    assert resources["document"]["encrypted"] is True
    assert encryption["filter"] == "Standard"
    assert encryption["version"] == 2
    assert encryption["revision"] == 3
    assert encryption["keyLength"] == 128
    permissions = encryption["permissions"]
    assert isinstance(permissions["raw"], int)
    assert permissions["print"] is True
    assert permissions["modify"] is False
    assert permissions["copy"] is False
    assert permissions["annotate"] is False
    assert permissions["fillForms"] is True
    assert permissions["accessibility"] is True
    assert permissions["assemble"] is True
    assert permissions["highQualityPrint"] is True


def test_permission_bits_map_exactly():
    assert security._permissions(-60) == {
        "raw": -60,
        "print": True,
        "modify": False,
        "copy": False,
        "annotate": False,
        "fillForms": True,
        "accessibility": True,
        "assemble": True,
        "highQualityPrint": True,
    }
    assert security._permissions(None) == {
        "raw": None,
        "print": None,
        "modify": None,
        "copy": None,
        "annotate": None,
        "fillForms": None,
        "accessibility": None,
        "assemble": None,
        "highQualityPrint": None,
    }


def test_unencrypted_document_has_no_encryption_block(tmp_path):
    resources = _collect(_page_pdf(tmp_path / "plain-encryption.pdf"))

    assert resources["encryption"] is None
    assert resources["document"]["encrypted"] is False


# --- malformed input --------------------------------------------------------


def test_malformed_catalog_and_xrefs_degrade_to_defaults():
    extractor = _FakeExtractor(
        catalog=_ExplodingMapping({"Lang": "en-US"}),
        xrefs=RuntimeError("broken xrefs"),
        version=None,
    )

    resources = security.collect_security(extractor)

    assert set(resources) == RESOURCE_KEYS
    assert resources["document"] == {
        "pages": 0,
        "version": "unknown",
        "encrypted": False,
        "xfa": False,
        "hasMetadata": False,
        "outputIntents": 0,
    }
    assert resources["attachments"] == []
    assert resources["javascript"] == []
    assert resources["actions"] == []
    assert resources["signatures"] == []
    assert resources["encryption"] is None


def test_broken_references_skip_one_entry_and_keep_the_rest(tmp_path):
    path = _page_pdf(
        tmp_path / "broken-tree.pdf",
        catalog_extra=b"/Names << /EmbeddedFiles 5 0 R >> /AcroForm 9 0 R",
        extra_objects=[
            b"<< /Kids [99 0 R 6 0 R] /Names [(bad.txt) 98 0 R] >>",
            b"<< /Names [(good.txt) 7 0 R] >>",
            b"<< /Type /Filespec /UF (good.txt) /EF << /F 8 0 R >> >>",
            _stream(b"ok", b"/Type /EmbeddedFile /Length 2"),
            b"<< /Fields [10 0 R] >>",
            b"<< /FT /Sig /T (Broken) /V 98 0 R >>",
        ],
    )

    resources = _collect(path)

    assert [a["name"] for a in resources["attachments"]] == ["good.txt"]
    assert resources["signatures"] == [
        {
            "fieldName": "Broken",
            "page": None,
            "signer": None,
            "signedAt": None,
            "reason": None,
            "location": None,
            "subFilter": None,
            "byteRangeValid": None,
            "verified": False,
        }
    ]


def test_security_module_does_not_import_audit():
    code = "import security, sys; assert 'audit' not in sys.modules"
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(Path(security.__file__).resolve().parent),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


# --- findings and report ----------------------------------------------------


def test_security_findings_flag_javascript_and_risky_actions(tmp_path):
    path = _page_pdf(
        tmp_path / "findings-actions.pdf",
        catalog_extra=b"/Names << /JavaScript 5 0 R >> /OpenAction 6 0 R"
        b" /AA << /WC 7 0 R /WS 8 0 R /DP 9 0 R >>",
        page_extra=b"/AA << /O 10 0 R >>",
        extra_objects=[
            b"<< /Names [(init) 11 0 R] >>",
            b"<< /S /JavaScript /JS (open) >>",
            b"<< /S /JavaScript /JS (auto) >>",
            b"<< /S /Launch /F (calc.exe) >>",
            b"<< /S /ImportData /F (data.fdf) >>",
            b"<< /S /SubmitForm /F (https://example.com/post) >>",
            b"<< /S /JavaScript /JS (init) >>",
        ],
    )

    findings = security_findings(_collect(path))
    by_title = {finding["title"]: finding for finding in findings}

    for title in (
        "Document contains JavaScript",
        "JavaScript runs automatically",
        "Launch action",
        "SubmitForm action",
        "ImportData action",
    ):
        assert by_title[title]["severity"] == "warning"
        assert by_title[title]["category"] == "security"
        assert by_title[title]["page"] is None
        assert by_title[title]["evidence"]


def test_security_findings_flag_embedded_files_xfa_and_signatures(tmp_path):
    findings = security_findings(_collect(_rich_pdf(tmp_path / "rich.pdf")))
    by_title = {finding["title"]: finding for finding in findings}

    assert by_title["Document contains embedded files"]["severity"] == "info"
    assert "evil.exe" in by_title["Document contains embedded files"]["evidence"]
    assert by_title["Risky attachment name: evil.exe"]["severity"] == "warning"
    assert by_title["Document contains an XFA form"]["severity"] == "warning"
    assert by_title["Document has a signature field"]["severity"] == "info"
    assert "not cryptographically verified" in (
        by_title["Document has a signature field"]["detail"]
    )


def test_clean_document_has_no_security_findings(tmp_path):
    assert security_findings(_collect(_page_pdf(tmp_path / "clean.pdf"))) == []


def test_security_findings_tolerate_empty_or_malformed_resources():
    assert security_findings({}) == []
    assert security_findings(
        {
            "document": None,
            "attachments": None,
            "javascript": "not-a-list",
            "actions": [None, "not-an-action"],
            "signatures": [],
            "encryption": "not-a-dictionary",
        }
    ) == []


def test_security_findings_report_encrypted_exactly_once(tmp_path):
    resources = _collect(_encrypted_pdf(tmp_path / "encrypted-finding.pdf"))

    assert resources["document"]["encrypted"] is True
    assert resources["encryption"] is not None
    encrypted = [
        finding
        for finding in security_findings(resources)
        if finding["title"] == "Document is encrypted"
    ]
    assert len(encrypted) == 1


def test_security_report_shape_and_summary(tmp_path):
    report = _security_report(_javascript_pdf(tmp_path / "report.pdf"))

    assert set(report) == REPORT_KEYS
    assert report["schemaVersion"] == 1
    assert report["tool"] == {"name": TOOL_NAME, "version": tool_version()}
    assert set(report["document"]) == DOCUMENT_KEYS
    assert report["summary"]["total"] == len(report["findings"])
    assert report["summary"]["total"] == sum(
        report["summary"][key] for key in ("errors", "warnings", "info")
    )
    assert audit.sort_findings(report["findings"]) == report["findings"]


def test_security_report_is_deterministic(tmp_path):
    path = _javascript_pdf(tmp_path / "report-deterministic.pdf")

    first = _security_report(path)
    second = _security_report(path)

    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


# --- audit integration ------------------------------------------------------


def test_audit_document_merges_security_findings_once(tmp_path, monkeypatch):
    path = _javascript_pdf(tmp_path / "audit-merge.pdf")
    calls = []
    original = audit.collect_security_with_meta

    def counting_collect(extractor):
        calls.append(extractor)
        return original(extractor)

    monkeypatch.setattr(audit, "collect_security_with_meta", counting_collect)

    result = _audit(path)

    assert len(calls) == 1
    titles = [finding["title"] for finding in result["findings"]]
    assert "Document contains JavaScript" in titles
    assert "JavaScript runs automatically" in titles
    assert any(finding["category"] == "security" for finding in result["findings"])


def test_audit_document_does_not_duplicate_the_encrypted_finding(tmp_path):
    result = _audit(_encrypted_pdf(tmp_path / "audit-encrypted.pdf"))
    encrypted = [
        finding
        for finding in result["findings"]
        if finding["title"] == "Document is encrypted"
    ]

    assert len(encrypted) == 1
    assert encrypted[0]["category"] == "security"
    assert encrypted[0]["severity"] == "warning"


def test_audit_file_includes_security_findings(tmp_path):
    report = audit_file(_javascript_pdf(tmp_path / "audit-file.pdf"))
    titles = [finding["title"] for finding in report["findings"]]

    assert "Document contains JavaScript" in titles
    assert "Document is encrypted" not in titles
    assert set(report) == {"schemaVersion", "tool", "document", "summary", "findings"}
    assert "attachments" not in report
