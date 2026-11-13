"""Diff resources R1: annotation/link/form/metadata/page-label collection.

Real minimal PDFs (reportlab and a raw writer) pin the structures the collector
walks: annotation dictionaries, URI/GoTo/Launch actions, widget fields with
inherited names, PageLabels ``/Nums`` and ``/Kids`` trees, info metadata and the
page signature.  Fake limits pin truncation, malformed references and identity
collision handling without building pathological files.
"""

from __future__ import annotations

import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfdoc
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import diff as diff_module  # noqa: E402
import diff_resources  # noqa: E402
from diff import diff_files  # noqa: E402
from diff_resources import (  # noqa: E402
    annotation_identity,
    collect_document_resources,
    collect_page_resources,
    form_identity,
    link_identity,
    page_resource_digest,
    resource_fingerprint,
    resource_identity,
)
from extractor import PdfExtractor  # noqa: E402

METADATA_KEYS = {
    "title",
    "author",
    "subject",
    "keywords",
    "creator",
    "producer",
    "creationDate",
    "modDate",
    "language",
}


# --- fixture helpers --------------------------------------------------------


def _stream(data: bytes, attrs: bytes = b"") -> bytes:
    return b"<< /Length %d " % len(data) + attrs + b" >>\nstream\n" + data + b"\nendstream"


def _string(text: str) -> bytes:
    data = text.encode("utf-8")
    data = data.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    return b"(" + data + b")"


def _write_pdf(
    path: Path,
    objects: list[bytes],
    trailer_extra: bytes = b"",
) -> str:
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
    media_box: bytes = b"[0 0 612 792]",
    trailer_extra: bytes = b"",
) -> str:
    """One-page PDF; extra objects are numbered from 5 onwards."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R " + catalog_extra + b" >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox "
        + media_box
        + b" /Contents 4 0 R "
        + page_extra
        + b" >>",
        _stream(b""),
    ] + list(extra_objects)
    return _write_pdf(path, objects, trailer_extra=trailer_extra)


def _reportlab_pdf(path: Path, draw) -> str:
    # ``invariant=1`` pins the info dict: R2 compares document metadata, so two
    # fixtures built in different seconds must not differ by CreationDate.
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, invariant=1)
    draw(canvas)
    canvas.save()
    return str(path)


def _collect(path) -> dict:
    extractor = PdfExtractor(str(path))
    try:
        return collect_document_resources(extractor)
    finally:
        extractor.close()


def _collect_page(path, page_num: int) -> dict:
    extractor = PdfExtractor(str(path))
    try:
        return collect_page_resources(extractor, page_num)
    finally:
        extractor.close()


def _signature(path) -> str:
    extractor = PdfExtractor(str(path))
    try:
        return diff_module._page_signature(extractor, 1, Path(path), "old")[0]
    finally:
        extractor.close()


def _same_content_pdf(path: Path, note: str | None) -> str:
    def draw(canvas) -> None:
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 720, "Identical content")
        if note is not None:
            canvas.textAnnotation(note, (100, 600, 200, 620))

    return _reportlab_pdf(path, draw)


def _annotation(content: bytes = b"Same", rect: bytes = b"[10 20 30 40]") -> bytes:
    return (
        b"<< /Type /Annot /Subtype /Square /Rect "
        + rect
        + b" /Contents "
        + content
        + b" >>"
    )


# --- document metadata ------------------------------------------------------


def test_metadata_fields_and_language(tmp_path):
    path = _page_pdf(
        tmp_path / "metadata.pdf",
        catalog_extra=b"/Lang (en-US)",
        extra_objects=[
            b"<< /Title (Doc title) /Author (Ada) /Subject (A subject)"
            b" /Keywords (alpha,beta) /Creator (Creator App)"
            b" /Producer (Producer App) /CreationDate (D:20240101000000Z)"
            b" /ModDate (D:20240202000000Z) >>"
        ],
        trailer_extra=b"/Info 5 0 R ",
    )

    resources = _collect(path)

    assert resources["metadata"] == {
        "title": "Doc title",
        "author": "Ada",
        "subject": "A subject",
        "keywords": "alpha,beta",
        "creator": "Creator App",
        "producer": "Producer App",
        "creationDate": "D:20240101000000Z",
        "modDate": "D:20240202000000Z",
        "language": "en-US",
    }
    assert set(resources["metadata"]) == METADATA_KEYS
    assert resources["pages"] == [
        {"page": 1, "annotations": [], "links": [], "forms": []}
    ]


def test_metadata_missing_is_null(tmp_path):
    path = _page_pdf(tmp_path / "empty-metadata.pdf")

    resources = _collect(path)

    assert all(value is None for value in resources["metadata"].values())
    assert set(resources["metadata"]) == METADATA_KEYS


def test_metadata_empty_values_are_normalised_to_null(tmp_path):
    path = _page_pdf(
        tmp_path / "empty-values.pdf",
        catalog_extra=b"/Lang ()",
        extra_objects=[b"<< /Title () /Author () /Keywords () >>"],
        trailer_extra=b"/Info 5 0 R ",
    )

    metadata = _collect(path)["metadata"]

    assert metadata["title"] is None
    assert metadata["author"] is None
    assert metadata["keywords"] is None
    assert metadata["language"] is None


# --- annotations ------------------------------------------------------------


def test_annotation_normalisation_and_nm_identity(tmp_path):
    path = _page_pdf(
        tmp_path / "annotation.pdf",
        page_extra=b"/Annots [5 0 R]",
        extra_objects=[
            b"<< /Type /Annot /Subtype /Square /Rect [100 200 300 400]"
            b" /Contents (Review this) /T (Reviewer) /C [1 .5 0]"
            b" /CA .5 /F 2 /NM (note-7) >>"
        ],
    )

    page = _collect(path)["pages"][0]

    assert page["page"] == 1
    assert page["links"] == []
    assert page["forms"] == []
    assert len(page["annotations"]) == 1
    annot = page["annotations"][0]
    assert annot["identity"] == "ann:nm:note-7"
    assert annot["nm"] == "note-7"
    assert annot["subtype"] == "Square"
    assert annot["rect"] == {"x0": 100.0, "y0": 200.0, "x1": 300.0, "y1": 400.0}
    assert annot["contents"] == "Review this"
    assert annot["title"] == "Reviewer"
    assert annot["color"] == [1.0, 0.5, 0.0]
    assert annot["opacity"] == 0.5
    assert annot["flags"] == 2
    assert annot["hidden"] is True
    assert annot["textTruncated"] is False


def test_annotation_rect_is_mediabox_relative(tmp_path):
    path = _page_pdf(
        tmp_path / "offset-media-box.pdf",
        media_box=b"[10 20 612 792]",
        page_extra=b"/Annots [5 0 R]",
        extra_objects=[
            b"<< /Type /Annot /Subtype /Square /Rect [100 200 300 400] >>"
        ],
    )

    rect = _collect(path)["pages"][0]["annotations"][0]["rect"]

    assert rect == {"x0": 90.0, "y0": 180.0, "x1": 290.0, "y1": 380.0}


def test_reportlab_annotation_subtype_content_and_color(tmp_path):
    def draw(canvas) -> None:
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 720, "Annotated")
        canvas.textAnnotation("A note", (100, 600, 200, 620))
        canvas.highlightAnnotation("Marked", (100, 500, 200, 520), Color=[1, 0.5, 0.2])

    path = _reportlab_pdf(tmp_path / "reportlab-annotations.pdf", draw)
    annotations = _collect(path)["pages"][0]["annotations"]

    assert [annot["subtype"] for annot in annotations] == ["Text", "Highlight"]
    assert annotations[0]["contents"] == "A note"
    assert annotations[0]["rect"] == {
        "x0": 100.0,
        "y0": 600.0,
        "x1": 200.0,
        "y1": 620.0,
    }
    assert annotations[1]["contents"] == "Marked"
    assert annotations[1]["color"] == [1.0, 0.5, 0.2]


def test_identity_falls_back_and_disambiguates_collisions(tmp_path):
    path = _page_pdf(
        tmp_path / "identity.pdf",
        page_extra=b"/Annots [5 0 R 6 0 R 7 0 R 8 0 R]",
        extra_objects=[
            _annotation(),  # no /NM
            _annotation(),  # identical: deterministic #2 suffix
            _annotation(rect=b"[11 21 31 41]"),  # different rect: own identity
            b"<< /Type /Annot /Subtype /Square /Rect [10 20 30 40]"
            b" /Contents (Same) /NM (stable-nm) >>",
        ],
    )

    first = _collect(path)["pages"][0]["annotations"]
    second = _collect(path)["pages"][0]["annotations"]
    identities = [annot["identity"] for annot in first]

    assert identities[0] == (
        "ann:subtype=Square|rect=10.00,20.00,30.00,40.00|contents=Same"
    )
    assert identities[1] == identities[0] + "#2"
    assert identities[2] == (
        "ann:subtype=Square|rect=11.00,21.00,31.00,41.00|contents=Same"
    )
    assert identities[3] == "ann:nm:stable-nm"
    assert len(set(identities)) == 4
    assert identities == [annot["identity"] for annot in second]
    assert annotation_identity(first[0]) == identities[0]


def test_annotation_subtype_routing_keeps_links_and_widgets_out(tmp_path):
    path = _page_pdf(
        tmp_path / "routing.pdf",
        page_extra=b"/Annots [5 0 R 6 0 R]",
        extra_objects=[
            b"<< /Type /Annot /Subtype /Link /Rect [10 10 20 20]"
            b" /A << /S /URI /URI (https://example.com) >> >>",
            b"<< /Type /Annot /Subtype /Widget /Rect [30 30 80 50]"
            b" /FT /Tx /T (field) /V (value) >>",
        ],
    )

    page = _collect(path)["pages"][0]

    assert page["annotations"] == []
    assert len(page["links"]) == 1
    assert len(page["forms"]) == 1


# --- links ------------------------------------------------------------------


def test_external_links_never_probe_and_flag_unsafe_schemes(tmp_path):
    path = _page_pdf(
        tmp_path / "links.pdf",
        page_extra=b"/Annots [5 0 R 6 0 R 7 0 R]",
        extra_objects=[
            b"<< /Type /Annot /Subtype /Link /Rect [10 10 20 20]"
            b" /A << /S /URI /URI (https://example.com/a?b=1) >> >>",
            b"<< /Type /Annot /Subtype /Link /Rect [30 10 40 20]"
            b" /A << /S /URI /URI (javascript:alert(1)) >> >>",
            b"<< /Type /Annot /Subtype /Link /Rect [50 10 60 20]"
            b" /A << /S /Launch /F (payload.exe) >> >>",
        ],
    )

    links = _collect(path)["pages"][0]["links"]

    assert links[0]["uri"] == "https://example.com/a?b=1"
    assert links[0]["target"] == "https://example.com/a?b=1"
    assert links[0]["unsafeUrl"] is False
    assert links[0]["action"] == "URI"
    assert links[0]["internalPage"] is None
    assert links[1]["uri"] == "javascript:alert(1)"
    assert links[1]["unsafeUrl"] is True
    # Launch is reported as metadata only; the target is never opened.
    assert links[2]["action"] == "Launch"
    assert links[2]["uri"] is None
    assert links[2]["unsafeUrl"] is False
    assert links[2]["target"] == "payload.exe"
    assert link_identity(links[0]).startswith("link:uri:https://example.com")


def test_internal_link_dest_page_ref(tmp_path):
    def draw(canvas) -> None:
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 720, "Go to page 1")
        canvas.bookmarkPage("top")
        canvas.linkRect("Jump", "top", (100, 300, 200, 320), relative=0)

    path = _reportlab_pdf(tmp_path / "internal-link.pdf", draw)
    links = _collect(path)["pages"][0]["links"]

    assert len(links) == 1
    assert links[0]["internalPage"] == 1
    assert links[0]["uri"] is None
    assert links[0]["unsafeUrl"] is False
    assert link_identity(links[0]).startswith("link:page:1|rect=")


def test_named_destination_and_goto_action_resolve_pages(tmp_path):
    # Two pages; page 1 has one named-destination link and one GoTo action link.
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /Dests << /chap2 [4 0 R /Fit] >> >>",
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
        b" /Annots [7 0 R 8 0 R] /Contents 5 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
        b" /Contents 6 0 R >>",
        _stream(b""),
        _stream(b""),
        b"<< /Type /Annot /Subtype /Link /Rect [10 10 20 20] /Dest (chap2) >>",
        b"<< /Type /Annot /Subtype /Link /Rect [30 10 40 20]"
        b" /A << /S /GoTo /D [4 0 R /Fit] >> >>",
    ]
    path = _write_pdf(tmp_path / "named-dest.pdf", objects)

    links = _collect(path)["pages"][0]["links"]

    assert links[0]["internalPage"] == 2
    assert links[1]["internalPage"] == 2
    assert links[1]["action"] == "GoTo"


def test_url_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_resources, "MAX_URL", 8)
    path = _page_pdf(
        tmp_path / "long-url.pdf",
        page_extra=b"/Annots [5 0 R]",
        extra_objects=[
            b"<< /Type /Annot /Subtype /Link /Rect [10 10 20 20]"
            b" /A << /S /URI /URI (https://example.com/very/long/path) >> >>"
        ],
    )

    link = _collect(path)["pages"][0]["links"][0]

    assert link["uri"] == "https://"
    assert link["target"] == "https://"
    assert link["urlTruncated"] is True


# --- forms ------------------------------------------------------------------


def test_reportlab_form_field_name_value_options_and_flags(tmp_path):
    def draw(canvas) -> None:
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 720, "Form")
        canvas.acroForm.textfield(
            name="first", value="Alice", x=100, y=200, width=150, height=20
        )
        canvas.acroForm.choice(
            name="color",
            value="Red",
            options=["Red", "Green"],
            x=100,
            y=150,
            width=120,
            height=20,
        )

    path = _reportlab_pdf(tmp_path / "form.pdf", draw)
    forms = _collect(path)["pages"][0]["forms"]

    assert [form["fieldName"] for form in forms] == ["first", "color"]
    text = forms[0]
    assert text["fieldType"] == "Tx"
    assert text["value"] == "Alice"
    assert text["defaultValue"] == "Alice"
    assert text["options"] is None
    assert text["flags"] == 0
    assert text["rect"] == {
        "x0": 100.0,
        "y0": 200.0,
        "x1": 250.0,
        "y1": 220.0,
    }
    choice = forms[1]
    assert choice["fieldType"] == "Ch"
    assert choice["value"] == "Red"
    assert choice["defaultValue"] == "Red"
    assert choice["options"] == ["Red", "Green"]
    assert choice["flags"] == 131072
    assert form_identity(choice).startswith("form:field=color|rect=")


def test_nested_form_field_name_and_parent_inheritance(tmp_path):
    path = _page_pdf(
        tmp_path / "nested-form.pdf",
        catalog_extra=b"/AcroForm << /Fields [5 0 R] >>",
        page_extra=b"/Annots [6 0 R]",
        extra_objects=[
            # Parent field: supplies /T prefix /FT /Ff and /DV.
            b"<< /T (person) /FT /Tx /Ff 0 /DV (Bob) /Kids [6 0 R] >>",
            # Terminal widget: own /T and /V, no /FT or /DV.
            b"<< /Type /Annot /Subtype /Widget /Rect [100 100 200 120]"
            b" /Parent 5 0 R /T (first) /V (Ada) >>",
        ],
    )

    form = _collect(path)["pages"][0]["forms"][0]

    assert form["fieldName"] == "person.first"
    assert form["fieldType"] == "Tx"
    assert form["value"] == "Ada"
    assert form["defaultValue"] == "Bob"
    assert form["flags"] == 0
    assert form["rect"] == {"x0": 100.0, "y0": 100.0, "x1": 200.0, "y1": 120.0}


def test_form_widget_without_t_inherits_parent_name(tmp_path):
    path = _page_pdf(
        tmp_path / "unnamed-widget.pdf",
        catalog_extra=b"/AcroForm << /Fields [5 0 R] >>",
        page_extra=b"/Annots [6 0 R]",
        extra_objects=[
            b"<< /T (person) /FT /Tx /Kids [6 0 R] >>",
            b"<< /Type /Annot /Subtype /Widget /Rect [100 100 200 120]"
            b" /Parent 5 0 R /V (Ada) >>",
        ],
    )

    form = _collect(path)["pages"][0]["forms"][0]

    assert form["fieldName"] == "person"
    assert form["fieldType"] == "Tx"
    assert form["value"] == "Ada"


# --- page labels ------------------------------------------------------------


def test_page_labels_nums_style_prefix_and_start(tmp_path):
    def draw(canvas) -> None:
        canvas.addPageLabel(0, style="ROMAN_LOWER")
        canvas.addPageLabel(2, style="ARABIC", start=1, prefix="A-")
        for page in range(4):
            canvas.setFont("Helvetica", 12)
            canvas.drawString(72, 720, f"Page {page + 1}")
            canvas.showPage()

    path = _reportlab_pdf(tmp_path / "page-labels.pdf", draw)

    labels = _collect(path)["pageLabels"]

    assert labels == [
        {"page": 1, "label": "i", "style": "r", "prefix": None, "start": None},
        {"page": 2, "label": "ii", "style": "r", "prefix": None, "start": None},
        {"page": 3, "label": "A-1", "style": "D", "prefix": "A-", "start": 1},
        {"page": 4, "label": "A-2", "style": "D", "prefix": "A-", "start": 1},
    ]


def test_page_labels_kids_number_tree(tmp_path):
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /PageLabels 5 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>",
        b"<< /Kids [8 0 R 9 0 R] >>",
        _stream(b""),
        _stream(b""),
        b"<< /Limits [0 0] /Nums [0 << /S /r >>] >>",
        b"<< /Limits [1 1] /Nums [1 << /S /D /St 5 >>] >>",
    ]
    path = _write_pdf(tmp_path / "labels-kids.pdf", objects)

    labels = _collect(path)["pageLabels"]

    assert [label["page"] for label in labels] == [1, 2]
    assert [label["label"] for label in labels] == ["i", "5"]
    assert labels[1]["style"] == "D"
    assert labels[1]["start"] == 5


def test_page_labels_equal_to_default_are_omitted(tmp_path):
    path = _page_pdf(
        tmp_path / "default-labels.pdf",
        catalog_extra=b"/PageLabels << /Nums [0 << /S /D /St 1 >>] >>",
    )

    assert _collect(path)["pageLabels"] == []


def test_page_label_prefix_only(tmp_path):
    path = _page_pdf(
        tmp_path / "cover-label.pdf",
        catalog_extra=b"/PageLabels << /Nums [0 << /P (Cover) >>] >>",
    )

    labels = _collect(path)["pageLabels"]

    assert labels == [
        {"page": 1, "label": "Cover", "style": None, "prefix": "Cover", "start": None}
    ]


# --- malformed input and bounds --------------------------------------------


def test_malformed_refs_degrade_and_are_counted(tmp_path):
    path = _page_pdf(
        tmp_path / "malformed.pdf",
        catalog_extra=b"/Lang 97 0 R /PageLabels 96 0 R",
        page_extra=b"/Annots [99 0 R 5 0 R]",
        extra_objects=[
            b"<< /Type /Annot /Subtype /Square /Rect [10 20 30 40]"
            b" /Contents (valid) >>"
        ],
        trailer_extra=b"/Info 98 0 R ",
    )

    resources = _collect(path)

    assert resources["metadata"]["title"] is None
    assert resources["metadata"]["language"] is None
    assert resources["pageLabels"] == []
    assert [annot["contents"] for annot in resources["pages"][0]["annotations"]] == [
        "valid"
    ]
    assert resources["skipped"] == {"annotations": 1}
    assert resources["truncated"] == {}


def test_annotations_per_page_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_resources, "MAX_ANNOTATIONS_PER_PAGE", 2)
    path = _page_pdf(
        tmp_path / "per-page-cap.pdf",
        page_extra=b"/Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R]",
        extra_objects=[_annotation() for _ in range(5)],
    )

    resources = _collect(path)

    assert len(resources["pages"][0]["annotations"]) == 2
    assert resources["truncated"] == {"annotationsPerPage": 3}


def test_document_annotation_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_resources, "MAX_ANNOTATIONS", 2)
    path = _page_pdf(
        tmp_path / "document-cap.pdf",
        page_extra=b"/Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R]",
        extra_objects=[_annotation() for _ in range(5)],
    )

    resources = _collect(path)

    assert len(resources["pages"][0]["annotations"]) == 2
    assert resources["truncated"] == {"annotations": 3}


def test_annotation_text_and_url_truncation_markers(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_resources, "MAX_TEXT", 10)
    monkeypatch.setattr(diff_resources, "MAX_URL", 8)
    path = _page_pdf(
        tmp_path / "truncated-values.pdf",
        page_extra=b"/Annots [5 0 R 6 0 R]",
        extra_objects=[
            b"<< /Type /Annot /Subtype /Square /Rect [10 20 30 40]"
            b" /Contents (abcdefghijklmnop) >>",
            b"<< /Type /Annot /Subtype /Link /Rect [10 50 20 60]"
            b" /A << /S /URI /URI (https://example.com/path) >> >>",
        ],
    )

    page = _collect(path)["pages"][0]

    assert page["annotations"][0]["contents"] == "abcdefghij"
    assert page["annotations"][0]["textTruncated"] is True
    assert page["links"][0]["uri"] == "https://"
    assert page["links"][0]["urlTruncated"] is True


def test_form_and_option_caps(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_resources, "MAX_FORMS", 1)
    monkeypatch.setattr(diff_resources, "MAX_FORM_OPTIONS", 2)

    def draw(canvas) -> None:
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 720, "Forms")
        canvas.acroForm.choice(
            name="color",
            value="Red",
            options=["Red", "Green", "Blue", "Black"],
            x=100,
            y=150,
            width=120,
            height=20,
        )
        canvas.acroForm.textfield(
            name="second", value="x", x=100, y=200, width=150, height=20
        )

    path = _reportlab_pdf(tmp_path / "form-caps.pdf", draw)
    resources = _collect(path)

    assert len(resources["pages"][0]["forms"]) == 1
    assert resources["pages"][0]["forms"][0]["options"] == ["Red", "Green"]
    assert resources["truncated"]["forms"] == 1
    assert resources["truncated"]["formOptions"] >= 1


def test_page_label_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_resources, "MAX_PAGE_LABELS", 2)

    def draw(canvas) -> None:
        canvas.addPageLabel(0, style="ROMAN_LOWER")
        for page in range(4):
            canvas.setFont("Helvetica", 12)
            canvas.drawString(72, 720, f"Page {page + 1}")
            canvas.showPage()

    path = _reportlab_pdf(tmp_path / "label-cap.pdf", draw)
    resources = _collect(path)

    assert len(resources["pageLabels"]) == 2
    assert resources["truncated"]["pageLabels"] >= 1


# --- determinism and digests ------------------------------------------------


def test_collection_is_deterministic_and_contains_no_paths(tmp_path):
    def draw(canvas) -> None:
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 720, "Stable")
        canvas.textAnnotation("Note", (100, 600, 200, 620))
        canvas.acroForm.textfield(
            name="first", value="Alice", x=100, y=400, width=150, height=20
        )

    path = _reportlab_pdf(tmp_path / "deterministic.pdf", draw)
    first = _collect(path)
    second = _collect(path)

    assert first == second
    payload = json.dumps(first, sort_keys=True, ensure_ascii=False)
    assert str(tmp_path) not in payload
    assert "/tmp/" not in payload
    assert first["truncated"] == {}
    assert first["skipped"] == {}


def test_page_digest_is_order_independent_and_content_sensitive(tmp_path):
    path = _page_pdf(
        tmp_path / "digest.pdf",
        page_extra=b"/Annots [5 0 R 6 0 R]",
        extra_objects=[
            _annotation(content=b"First", rect=b"[10 20 30 40]"),
            _annotation(content=b"Second", rect=b"[50 60 70 80]"),
        ],
    )
    page = _collect(path)["pages"][0]
    digest = page_resource_digest(page)

    reordered = deepcopy(page)
    reordered["annotations"].reverse()
    assert page_resource_digest(reordered) == digest

    changed = deepcopy(page)
    changed["annotations"][0]["contents"] = "Changed"
    assert page_resource_digest(changed) != digest

    resources = _collect(path)
    assert resource_fingerprint(resources) == resource_fingerprint(_collect(path))


def test_resource_identity_dispatch(tmp_path):
    annotation = {"nm": "a1", "subtype": "Text", "rect": None, "contents": "x"}
    link = {"nm": None, "uri": "https://example.com", "rect": None}
    form = {"fieldName": "person.first", "rect": {"x0": 0, "y0": 0, "x1": 1, "y1": 1}}

    assert resource_identity("annotation", annotation) == "ann:nm:a1"
    assert resource_identity("link", link).startswith("link:uri:")
    assert resource_identity("form", form).startswith("form:field=person.first|rect=")


def test_collect_page_resources_matches_document_entry_and_validates_page(tmp_path):
    path = _same_content_pdf(tmp_path / "one-page.pdf", "Note")

    resources = _collect(path)
    page = _collect_page(path, 1)

    assert page == resources["pages"][0]
    with pytest.raises(ValueError):
        _collect_page(path, 2)
    with pytest.raises(ValueError):
        _collect_page(path, 0)


# --- page signature / fast path --------------------------------------------


def test_page_signature_includes_annotations(tmp_path):
    base = _same_content_pdf(tmp_path / "base.pdf", "Note A")
    edited = _same_content_pdf(tmp_path / "edited.pdf", "Note B")
    same = _same_content_pdf(tmp_path / "same.pdf", "Note A")
    plain_a = _same_content_pdf(tmp_path / "plain-a.pdf", None)
    plain_b = _same_content_pdf(tmp_path / "plain-b.pdf", None)

    base_signature = _signature(base)

    # Same content stream, different annotation: the signature must change.
    assert _signature(edited) != base_signature
    # Same annotation content in another file: the signature must stay stable.
    assert _signature(same) == base_signature
    # Pages without annotations keep their old equality behaviour.
    assert _signature(plain_a) == _signature(plain_b) != base_signature


def test_annotation_only_change_is_not_fast_path_unchanged(tmp_path, monkeypatch):
    old = _same_content_pdf(tmp_path / "old.pdf", "Note A")
    new = _same_content_pdf(tmp_path / "new.pdf", "Note B")
    same = _same_content_pdf(tmp_path / "same.pdf", "Note A")

    calls: list[int] = []
    original = PdfExtractor.extract_page

    def spy(self, page_num, include_types=None):
        calls.append(page_num)
        return original(self, page_num, include_types=include_types)

    monkeypatch.setattr(PdfExtractor, "extract_page", spy)

    changed = diff_files(old, new)
    assert calls == [1, 1]
    assert changed["pages"][0]["status"] == "changed"
    assert changed["pages"][0]["match"]["score"] < 1.0
    # R1 only collected; R2a compares.  reportlab's text annotation carries no
    # /NM, so its identity embeds the contents and the edit shows up as one
    # removed plus one added annotation (see the compare suite for /NM cases).
    resource_changes = changed["pages"][0]["changes"]
    assert {change["type"] for change in resource_changes} == {"annotation"}
    assert sorted(change["kind"] for change in resource_changes) == ["added", "removed"]
    assert changed["summary"]["objectsAdded"] == 0
    assert changed["summary"]["objectsRemoved"] == 0
    assert changed["summary"]["resourcesAdded"] == 1
    assert changed["summary"]["resourcesRemoved"] == 1
    # No metadata or page-label difference: the document-level block is absent.
    assert "documentChanges" not in changed

    calls.clear()
    unchanged = diff_files(old, same)
    assert calls == []
    assert unchanged["pages"][0]["match"] == {"score": 1.0, "reordered": False}
    assert unchanged["pages"][0]["changes"] == []


def test_pages_without_annotations_keep_the_fast_path(tmp_path, monkeypatch):
    old = _same_content_pdf(tmp_path / "plain-old.pdf", None)
    new = _same_content_pdf(tmp_path / "plain-new.pdf", None)

    calls: list[int] = []
    original = PdfExtractor.extract_page

    def spy(self, page_num, include_types=None):
        calls.append(page_num)
        return original(self, page_num, include_types=include_types)

    monkeypatch.setattr(PdfExtractor, "extract_page", spy)

    result = diff_files(old, new)

    assert calls == []
    assert result["pages"][0]["status"] == "unchanged"
    assert result["pages"][0]["match"] == {"score": 1.0, "reordered": False}
