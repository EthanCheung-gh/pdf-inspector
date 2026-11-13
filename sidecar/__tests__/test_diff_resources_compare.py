"""Diff resources R2a: page resource comparison and document changes.

Real minimal PDFs pin the comparison the engine performs on top of the object
diff: annotations, links and form widgets paired by the R1 identity, metadata and
page labels as ``documentChanges``, the shared change cap, ignore flags, ignore
regions and the page fast path.  Every fixture is written by hand (or by
reportlab with ``invariant=1``) so metadata, object numbers and timestamps are
deterministic.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import diff as diff_module  # noqa: E402
import diff_resources  # noqa: E402
from diff import DiffOptions, diff_files  # noqa: E402
from extractor import PdfExtractor  # noqa: E402

CHANGE_KEYS = {
    "kind",
    "type",
    "oldPage",
    "newPage",
    "oldBBox",
    "newBBox",
    "textOld",
    "textNew",
    "details",
}
DOCUMENT_CHANGE_KEYS = {
    "kind",
    "type",
    "page",
    "field",
    "oldValue",
    "newValue",
    "details",
}


# --- fixture builders -------------------------------------------------------


def _stream(data: bytes, attrs: bytes = b"") -> bytes:
    return b"<< /Length %d " % len(data) + attrs + b" >>\nstream\n" + data + b"\nendstream"


def _string(text: str) -> bytes:
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


def _build(
    path: Path,
    *,
    page_count: int = 1,
    annots: dict[int, list[bytes]] | None = None,
    catalog_extra: bytes = b"",
    metadata: bytes | None = None,
    page_labels: bytes | None = None,
) -> str:
    """A minimal PDF: empty pages plus optional annots, info dict and labels.

    Empty content streams keep the object diff empty, so a test that changes only
    resources or metadata observes exactly the resource side of the result.
    """
    annots = annots or {}
    bodies: dict[int, bytes] = {}
    page_numbers: list[int] = []
    content_numbers: list[int] = []
    next_number = 3
    for _ in range(page_count):
        page_numbers.append(next_number)
        content_numbers.append(next_number + 1)
        next_number += 2

    annot_numbers: dict[int, list[int]] = {}
    for page in sorted(annots):
        numbers = []
        for body in annots[page]:
            numbers.append(next_number)
            bodies[next_number] = body
            next_number += 1
        annot_numbers[page] = numbers

    info_number = None
    if metadata is not None:
        info_number = next_number
        next_number += 1
    labels_number = None
    if page_labels is not None:
        labels_number = next_number
        next_number += 1

    catalog = b"<< /Type /Catalog /Pages 2 0 R"
    if labels_number is not None:
        catalog += b" /PageLabels %d 0 R" % labels_number
    if catalog_extra:
        catalog += b" " + catalog_extra
    bodies[1] = catalog + b" >>"
    kids = b" ".join(b"%d 0 R" % number for number in page_numbers)
    bodies[2] = b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % page_count
    for index, page_number in enumerate(page_numbers, start=1):
        body = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R"
            % content_numbers[index - 1]
        )
        numbers = annot_numbers.get(index)
        if numbers:
            body += b" /Annots [" + b" ".join(b"%d 0 R" % number for number in numbers) + b"]"
        bodies[page_number] = body + b" >>"
        bodies[content_numbers[index - 1]] = _stream(b"")
    if info_number is not None:
        bodies[info_number] = metadata
    if labels_number is not None:
        bodies[labels_number] = page_labels

    objects = [bodies[number] for number in range(1, next_number)]
    trailer_extra = b""
    if info_number is not None:
        trailer_extra = b"/Info %d 0 R " % info_number
    return _write_pdf(path, objects, trailer_extra=trailer_extra)


def _annotation(
    *,
    nm: str | None = None,
    contents: str = "Note",
    rect: bytes = b"[100 200 300 400]",
    color: bytes | None = None,
    subtype: bytes = b"/Square",
    extra: bytes = b"",
) -> bytes:
    body = b"<< /Type /Annot /Subtype " + subtype + b" /Rect " + rect
    if nm is not None:
        body += b" /NM " + _string(nm)
    body += b" /Contents " + _string(contents)
    if color is not None:
        body += b" /C " + color
    if extra:
        body += b" " + extra
    return body + b" >>"


def _uri_link(
    *,
    nm: str | None = None,
    uri: str = "https://example.com/old",
    rect: bytes = b"[10 10 110 30]",
) -> bytes:
    body = b"<< /Type /Annot /Subtype /Link /Rect " + rect
    if nm is not None:
        body += b" /NM " + _string(nm)
    return body + b" /A << /S /URI /URI " + _string(uri) + b" >> >>"


def _dest_link(
    *,
    nm: str | None = None,
    dest: str = "chap",
    rect: bytes = b"[10 40 110 60]",
) -> bytes:
    body = b"<< /Type /Annot /Subtype /Link /Rect " + rect
    if nm is not None:
        body += b" /NM " + _string(nm)
    return body + b" /Dest " + _string(dest) + b" >>"


def _widget(
    *,
    name: str = "person",
    value: str = "Alice",
    default: str | None = None,
    options: bytes | None = None,
    rect: bytes = b"[100 500 300 520]",
) -> bytes:
    body = b"<< /Type /Annot /Subtype /Widget /Rect " + rect
    body += b" /FT /Tx /T " + _string(name) + b" /V " + _string(value)
    if default is not None:
        body += b" /DV " + _string(default)
    if options is not None:
        body += b" /Opt " + options
    return body + b" >>"


def _page_object_number(page: int) -> int:
    """Object number of 1-based ``page`` in a :func:`_build` PDF.

    The layout is fixed: catalog 1, page tree 2, then two objects (page and
    content stream) per page.
    """
    return 3 + 2 * (page - 1)


def _reportlab_pdf(path: Path, draw) -> str:
    """Reportlab page with fixed metadata (``invariant``), so only content varies."""
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, invariant=1)
    draw(canvas)
    canvas.save()
    return str(path)


def _text_pdf(path: Path, text: str) -> str:
    def draw(canvas) -> None:
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 720, text)

    return _reportlab_pdf(path, draw)


# --- assertion helpers ------------------------------------------------------


def _changes(result, page_index: int = 0, type_: str | None = None):
    return [
        change
        for change in result["pages"][page_index]["changes"]
        if type_ is None or change["type"] == type_
    ]


def _document_changes(result, type_: str | None = None):
    return [
        change
        for change in result.get("documentChanges") or ()
        if type_ is None or change["type"] == type_
    ]


# --- annotations ------------------------------------------------------------


def test_annotation_content_change_is_modified(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        annots={1: [_annotation(nm="a1", contents="Old note")]},
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={1: [_annotation(nm="a1", contents="New note")]},
    )

    result = diff_files(old, new)
    page = result["pages"][0]

    assert page["status"] == "changed"
    changes = _changes(result)
    assert [change["kind"] for change in changes] == ["modified"]
    change = changes[0]
    assert set(change) == CHANGE_KEYS
    assert change["type"] == "annotation"
    assert change["oldPage"] == 1 and change["newPage"] == 1
    assert change["oldBBox"] == change["newBBox"] == {
        "x0": 100.0,
        "y0": 200.0,
        "x1": 300.0,
        "y1": 400.0,
    }
    assert change["textOld"] == "Old note"
    assert change["textNew"] == "New note"
    assert change["details"]["resource"] == "annotation"
    assert change["details"]["identity"] == "ann:nm:a1"
    assert change["details"]["contents"] == {"old": "Old note", "new": "New note"}
    # Resource changes never enter the object counters.
    assert result["summary"]["objectsModified"] == 0
    assert result["summary"]["resourcesModified"] == 1
    assert result["summary"]["resourcesAdded"] == 0
    assert result["summary"]["resourcesRemoved"] == 0
    assert result["summary"]["documentChanges"] == 0
    assert "documentChanges" not in result


def test_annotation_colour_and_opacity_changes_are_modified(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        annots={1: [_annotation(nm="a1", contents="Mark", color=b"[1 0 0]", extra=b"/CA 1")]},
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={1: [_annotation(nm="a1", contents="Mark", color=b"[0 0 1]", extra=b"/CA .5")]},
    )

    change = _changes(diff_files(old, new))[0]

    assert change["kind"] == "modified"
    assert change["details"]["color"] == {"old": [1.0, 0.0, 0.0], "new": [0.0, 0.0, 1.0]}
    assert change["details"]["opacity"] == {"old": 1.0, "new": 0.5}
    # Unchanged fields are not reported.
    assert "contents" not in change["details"]
    assert "rect" not in change["details"]


def test_moved_annotation_with_nm_is_moved(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        annots={1: [_annotation(nm="a1", rect=b"[100 200 300 400]")]},
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={1: [_annotation(nm="a1", rect=b"[120 220 320 420]")]},
    )

    result = diff_files(old, new)
    changes = _changes(result)

    assert [change["kind"] for change in changes] == ["moved"]
    change = changes[0]
    assert change["type"] == "annotation"
    assert change["oldBBox"] == {"x0": 100.0, "y0": 200.0, "x1": 300.0, "y1": 400.0}
    assert change["newBBox"] == {"x0": 120.0, "y0": 220.0, "x1": 320.0, "y1": 420.0}
    assert change["details"]["rect"] == {
        "old": {"x0": 100.0, "y0": 200.0, "x1": 300.0, "y1": 400.0},
        "new": {"x0": 120.0, "y0": 220.0, "x1": 320.0, "y1": 420.0},
    }
    # A move is neither added, removed nor modified in the summary counters.
    assert result["summary"]["resourcesAdded"] == 0
    assert result["summary"]["resourcesRemoved"] == 0
    assert result["summary"]["resourcesModified"] == 0
    # ... but it is counted, so a report cannot list a move while saying 0/0/0.
    assert result["summary"]["resourcesMoved"] == 1
    assert result["summary"]["objectsMoved"] == 0


def test_moved_annotation_without_nm_is_added_and_removed(tmp_path):
    """Documented limitation: a rect-embedding identity cannot report a move."""
    old = _build(tmp_path / "old.pdf", annots={1: [_annotation(rect=b"[100 200 300 400]")]})
    new = _build(tmp_path / "new.pdf", annots={1: [_annotation(rect=b"[120 220 320 420]")]})

    result = diff_files(old, new)
    changes = _changes(result)

    assert sorted(change["kind"] for change in changes) == ["added", "removed"]
    assert result["summary"]["resourcesAdded"] == 1
    assert result["summary"]["resourcesRemoved"] == 1


def test_added_and_removed_annotations_keep_their_side(tmp_path):
    old = _build(tmp_path / "old.pdf", annots={1: [_annotation(nm="gone", contents="Old")]})
    new = _build(tmp_path / "new.pdf", annots={1: [_annotation(nm="fresh", contents="New")]})

    result = diff_files(old, new)
    by_kind = {change["kind"]: change for change in _changes(result)}

    # The page itself is paired, so both page numbers name the aligned pair; the
    # missing side is expressed by the absent box and text.
    removed = by_kind["removed"]
    assert removed["oldPage"] == 1 and removed["newPage"] == 1
    assert removed["oldBBox"] is not None and removed["newBBox"] is None
    assert removed["textOld"] == "Old" and removed["textNew"] is None
    assert removed["details"]["contents"] == {"old": "Old", "new": None}

    added = by_kind["added"]
    assert added["oldPage"] == 1 and added["newPage"] == 1
    assert added["oldBBox"] is None and added["newBBox"] is not None
    assert added["textOld"] is None and added["textNew"] == "New"
    assert added["details"]["contents"] == {"old": None, "new": "New"}


# --- links ------------------------------------------------------------------


def test_link_uri_change_with_nm_is_modified(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        annots={1: [_uri_link(nm="l1", uri="https://example.com/old")]},
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={1: [_uri_link(nm="l1", uri="https://example.com/new")]},
    )

    result = diff_files(old, new)
    changes = _changes(result)

    assert [change["kind"] for change in changes] == ["modified"]
    change = changes[0]
    assert change["type"] == "link"
    assert change["details"]["resource"] == "link"
    assert change["details"]["identity"] == "link:nm:l1"
    assert change["details"]["uri"] == {
        "old": "https://example.com/old",
        "new": "https://example.com/new",
    }
    assert change["details"]["target"] == {
        "old": "https://example.com/old",
        "new": "https://example.com/new",
    }
    # The target is reported as text only: nothing is opened.
    assert change["textOld"] == "https://example.com/old"
    assert change["textNew"] == "https://example.com/new"
    assert result["summary"]["resourcesModified"] == 1


def test_link_uri_change_without_nm_is_added_and_removed(tmp_path):
    old = _build(tmp_path / "old.pdf", annots={1: [_uri_link(uri="https://example.com/old")]})
    new = _build(tmp_path / "new.pdf", annots={1: [_uri_link(uri="https://example.com/new")]})

    result = diff_files(old, new)

    assert sorted(change["kind"] for change in _changes(result)) == ["added", "removed"]
    assert {change["type"] for change in _changes(result)} == {"link"}


def test_internal_link_page_change_is_modified_without_object_extraction(tmp_path):
    """The catalog is not part of the page signature: only resources differ."""

    def build(path: Path, target_page: int) -> str:
        return _build(
            path,
            page_count=3,
            annots={1: [_dest_link(nm="l1", dest="chap")]},
            catalog_extra=b"/Dests << /chap [%d 0 R /Fit] >>"
            % _page_object_number(target_page),
        )

    old = build(tmp_path / "old.pdf", 2)
    new = build(tmp_path / "new.pdf", 3)

    calls: list[int] = []
    original = PdfExtractor.extract_page

    def spy(self, page_num, include_types=None):
        calls.append(page_num)
        return original(self, page_num, include_types=include_types)

    PdfExtractor.extract_page = spy
    try:
        result = diff_files(old, new)
    finally:
        PdfExtractor.extract_page = original

    # Equal page signatures: no layout parse at all, but the resource comparison
    # still runs and reports the change.
    assert calls == []
    page = result["pages"][0]
    assert page["status"] == "changed"
    assert page["match"] == {"score": 1.0, "reordered": False}
    changes = _changes(result)
    assert [change["kind"] for change in changes] == ["modified"]
    assert changes[0]["type"] == "link"
    assert changes[0]["details"]["internalPage"] == {"old": 2, "new": 3}
    assert changes[0]["textOld"] == "chap" and changes[0]["textNew"] == "chap"


# --- form widgets -----------------------------------------------------------


def test_form_value_change_is_modified(tmp_path):
    old = _build(tmp_path / "old.pdf", annots={1: [_widget(name="person", value="Alice")]})
    new = _build(tmp_path / "new.pdf", annots={1: [_widget(name="person", value="Bob")]})

    result = diff_files(old, new)
    changes = _changes(result)

    assert [change["kind"] for change in changes] == ["modified"]
    change = changes[0]
    assert change["type"] == "form"
    assert change["details"]["resource"] == "form"
    assert change["details"]["identity"] == (
        "form:field=person|rect=100.00,500.00,300.00,520.00"
    )
    assert change["details"]["value"] == {"old": "Alice", "new": "Bob"}
    assert change["textOld"] == "Alice"
    assert change["textNew"] == "Bob"
    assert change["oldBBox"] == {
        "x0": 100.0,
        "y0": 500.0,
        "x1": 300.0,
        "y1": 520.0,
    }
    assert result["summary"]["resourcesModified"] == 1


def test_form_default_value_and_options_change_is_modified(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        annots={
            1: [
                _widget(
                    name="choice",
                    value="Red",
                    default="Red",
                    options=b"[ (Red) (Green) ]",
                )
            ]
        },
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={
            1: [
                _widget(
                    name="choice",
                    value="Red",
                    default="Green",
                    options=b"[ (Red) (Green) (Blue) ]",
                )
            ]
        },
    )

    change = _changes(diff_files(old, new))[0]

    assert change["type"] == "form"
    assert change["details"]["defaultValue"] == {"old": "Red", "new": "Green"}
    assert change["details"]["options"] == {
        "old": ["Red", "Green"],
        "new": ["Red", "Green", "Blue"],
    }
    # The value itself did not change, so it is not reported.
    assert "value" not in change["details"]


# --- ignore flags -----------------------------------------------------------


def _mixed_pair(tmp_path):
    """One page whose annotation, link, form, metadata and labels all changed."""
    old = _build(
        tmp_path / "old.pdf",
        annots={
            1: [
                _annotation(nm="a1", contents="Old note"),
                _uri_link(nm="l1", uri="https://example.com/old"),
                _widget(name="person", value="Alice"),
            ]
        },
        metadata=b"<< /Title (Old title) >>",
        page_labels=b"<< /Nums [0 << /S /r >>] >>",
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={
            1: [
                _annotation(nm="a1", contents="New note"),
                _uri_link(nm="l1", uri="https://example.com/new"),
                _widget(name="person", value="Bob"),
            ]
        },
        metadata=b"<< /Title (New title) >>",
        page_labels=b"<< /Nums [0 << /S /D /St 5 >>] >>",
    )
    return old, new


def test_every_resource_kind_is_reported_by_default(tmp_path):
    old, new = _mixed_pair(tmp_path)

    result = diff_files(old, new)

    assert {change["type"] for change in _changes(result)} == {
        "annotation",
        "link",
        "form",
    }
    assert {change["type"] for change in _document_changes(result)} == {
        "metadata",
        "page-label",
    }
    assert result["summary"]["resourcesModified"] == 3
    assert result["summary"]["documentChanges"] == 2


@pytest.mark.parametrize(
    ("options", "page_types", "document_types"),
    [
        (DiffOptions(ignore_annotations=True), {"link", "form"}, {"metadata", "page-label"}),
        (DiffOptions(ignore_links=True), {"annotation", "form"}, {"metadata", "page-label"}),
        (DiffOptions(ignore_forms=True), {"annotation", "link"}, {"metadata", "page-label"}),
        (DiffOptions(ignore_metadata=True), {"annotation", "link", "form"}, {"page-label"}),
        (DiffOptions(ignore_page_labels=True), {"annotation", "link", "form"}, {"metadata"}),
        (
            DiffOptions(
                ignore_annotations=True,
                ignore_links=True,
                ignore_forms=True,
                ignore_metadata=True,
                ignore_page_labels=True,
            ),
            set(),
            set(),
        ),
    ],
)
def test_ignore_flags_remove_only_their_kind(tmp_path, options, page_types, document_types):
    old, new = _mixed_pair(tmp_path)

    result = diff_files(old, new, options)

    assert {change["type"] for change in _changes(result)} == page_types
    assert {change["type"] for change in _document_changes(result)} == document_types


def test_ignoring_every_resource_keeps_the_legacy_payload_shape(tmp_path):
    old, new = _mixed_pair(tmp_path)

    result = diff_files(
        old,
        new,
        DiffOptions(
            ignore_annotations=True,
            ignore_links=True,
            ignore_forms=True,
            ignore_metadata=True,
            ignore_page_labels=True,
        ),
    )

    # Nothing to report: the pages only differ by resources, so they are equal.
    assert [page["status"] for page in result["pages"]] == ["unchanged"]
    assert result["pages"][0]["changes"] == []
    assert "documentChanges" not in result
    assert "resourcesAdded" not in result["summary"]
    assert "documentChanges" not in result["summary"]
    assert set(result["summary"]) == {
        "pagesAdded",
        "pagesRemoved",
        "pagesChanged",
        "pagesReordered",
        "objectsAdded",
        "objectsRemoved",
        "objectsMoved",
        "objectsModified",
        "changesTruncated",
    }


RESOURCE_OPTION_KEYS = (
    "ignoreAnnotations",
    "ignoreLinks",
    "ignoreForms",
    "ignoreMetadata",
    "ignorePageLabels",
)


def test_options_echo_carries_the_resource_flags(tmp_path):
    """The camelCase options echo shows which resources were compared.

    The five switches are always present (like the legacy booleans), so a JSON
    or HTML consumer can tell "compared, no changes" apart from "not compared".
    """
    old, new = _mixed_pair(tmp_path)

    default = diff_files(old, new)["options"]
    assert set(default) == {
        "positionTolerance",
        "textTolerance",
        "ignoreTypes",
        "ignoreFonts",
        "ignoreColors",
        "ignoreImages",
        "ignoreAnnotations",
        "ignoreLinks",
        "ignoreForms",
        "ignoreMetadata",
        "ignorePageLabels",
        "ignoreRegions",
    }
    for key in RESOURCE_OPTION_KEYS:
        assert default[key] is False
    # Legacy fields keep their values.
    assert default["ignoreFonts"] is False
    assert default["ignoreColors"] is False
    assert default["ignoreImages"] is False

    ignored = diff_files(
        old,
        new,
        DiffOptions(ignore_metadata=True, ignore_page_labels=True),
    )["options"]
    assert ignored["ignoreMetadata"] is True
    assert ignored["ignorePageLabels"] is True
    assert ignored["ignoreAnnotations"] is False
    assert ignored["ignoreLinks"] is False
    assert ignored["ignoreForms"] is False


# --- ignore regions ---------------------------------------------------------


def test_ignore_region_masks_resource_changes_with_a_bbox(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        annots={
            1: [
                _annotation(nm="a1", contents="Inside", rect=b"[100 200 300 400]"),
                _annotation(nm="a2", contents="Outside", rect=b"[400 600 500 700]"),
            ]
        },
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={
            1: [
                _annotation(nm="a1", contents="Inside edited", rect=b"[100 200 300 400]"),
                _annotation(nm="a2", contents="Outside edited", rect=b"[400 600 500 700]"),
            ]
        },
    )

    unmasked = diff_files(old, new)
    assert {change["details"]["identity"] for change in _changes(unmasked)} == {
        "ann:nm:a1",
        "ann:nm:a2",
    }

    masked = diff_files(
        old,
        new,
        DiffOptions(
            ignore_regions=[
                {"oldPage": 1, "newPage": 1, "bbox": {"x0": 90, "y0": 190, "x1": 310, "y1": 410}}
            ]
        ),
    )

    assert [change["details"]["identity"] for change in _changes(masked)] == ["ann:nm:a2"]
    assert masked["summary"]["resourcesModified"] == 1


def test_ignore_region_does_not_affect_document_changes(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        metadata=b"<< /Title (Old title) >>",
        page_labels=b"<< /Nums [0 << /S /r >>] >>",
    )
    new = _build(
        tmp_path / "new.pdf",
        metadata=b"<< /Title (New title) >>",
        page_labels=b"<< /Nums [0 << /S /D /St 5 >>] >>",
    )

    result = diff_files(
        old,
        new,
        DiffOptions(
            ignore_regions=[
                {"oldPage": 1, "newPage": 1, "bbox": {"x0": 0, "y0": 0, "x1": 612, "y1": 792}}
            ]
        ),
    )

    assert {change["type"] for change in _document_changes(result)} == {
        "metadata",
        "page-label",
    }


# --- metadata and page labels ----------------------------------------------


def test_metadata_change_is_a_document_change_and_keeps_pages_unchanged(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        metadata=b"<< /Title (Old title) /Author (Ada) /Keywords (alpha) >>",
    )
    new = _build(
        tmp_path / "new.pdf",
        metadata=b"<< /Title (New title) /Author (Ada) >>",
    )

    result = diff_files(old, new)
    changes = _document_changes(result)

    assert [page["status"] for page in result["pages"]] == ["unchanged"]
    assert result["pages"][0]["changes"] == []
    assert result["summary"]["pagesChanged"] == 0
    assert result["summary"]["documentChanges"] == len(changes) == 2
    assert all(set(change) == DOCUMENT_CHANGE_KEYS for change in changes)
    assert [(change["field"], change["kind"]) for change in changes] == [
        ("title", "modified"),
        ("keywords", "removed"),
    ]
    assert changes[0]["type"] == "metadata"
    assert changes[0]["page"] is None
    assert changes[0]["oldValue"] == "Old title"
    assert changes[0]["newValue"] == "New title"
    assert changes[0]["details"] == {}
    assert changes[1]["oldValue"] == "alpha"
    assert changes[1]["newValue"] is None
    # Nothing is duplicated into a page change list.
    assert _changes(result) == []


def test_metadata_added_field_is_reported_as_added(tmp_path):
    old = _build(tmp_path / "old.pdf", metadata=b"<< /Title (Doc) >>")
    # /Lang lives in the catalog, not in the info dict.
    new = _build(
        tmp_path / "new.pdf",
        metadata=b"<< /Title (Doc) /Author (Ada) >>",
        catalog_extra=b"/Lang (en-US)",
    )

    changes = _document_changes(diff_files(old, new))

    assert [(change["field"], change["kind"]) for change in changes] == [
        ("author", "added"),
        ("language", "added"),
    ]
    assert changes[0]["oldValue"] is None
    assert changes[0]["newValue"] == "Ada"
    assert changes[1]["newValue"] == "en-US"


def test_page_label_change_is_a_document_change_with_the_page_number(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        page_count=3,
        page_labels=b"<< /Nums [0 << /S /r >> 2 << /S /D /St 1 >>] >>",
    )
    new = _build(
        tmp_path / "new.pdf",
        page_count=3,
        page_labels=b"<< /Nums [0 << /S /r >> 2 << /S /D /St 5 >>] >>",
    )

    result = diff_files(old, new)
    changes = _document_changes(result)

    assert result["summary"]["pagesChanged"] == 0
    assert [change["type"] for change in changes] == ["page-label"]
    change = changes[0]
    assert set(change) == DOCUMENT_CHANGE_KEYS
    assert change["kind"] == "modified"
    assert change["page"] == 3
    assert change["field"] == "page-label"
    assert change["oldValue"] == "1"
    assert change["newValue"] == "5"
    assert change["details"]["start"] == {"old": 1, "new": 5}
    # The label change is not duplicated into the page's change list.
    assert result["pages"][2]["changes"] == []


def test_page_label_style_change_marks_every_page(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        page_count=2,
        page_labels=b"<< /Nums [0 << /S /r >>] >>",
    )
    new = _build(
        tmp_path / "new.pdf",
        page_count=2,
        page_labels=b"<< /Nums [0 << /S /A >>] >>",
    )

    changes = _document_changes(diff_files(old, new))

    assert [(change["page"], change["kind"]) for change in changes] == [
        (1, "modified"),
        (2, "modified"),
    ]
    assert changes[0]["oldValue"] == "i"
    assert changes[0]["newValue"] == "A"


# --- one-sided pages --------------------------------------------------------


def test_added_page_reports_its_resources_as_added(tmp_path):
    old = _build(tmp_path / "old.pdf", page_count=1)
    new = _build(
        tmp_path / "new.pdf",
        page_count=2,
        annots={2: [_annotation(nm="a1", contents="New note")]},
    )

    result = diff_files(old, new)
    page = result["pages"][1]

    assert page["status"] == "added"
    changes = _changes(result, 1)
    assert [(change["kind"], change["type"]) for change in changes] == [
        ("added", "annotation")
    ]
    assert changes[0]["oldPage"] is None
    assert changes[0]["newPage"] == 2
    assert changes[0]["textNew"] == "New note"
    assert result["summary"]["resourcesAdded"] == 1


def test_removed_page_reports_its_resources_as_removed(tmp_path):
    old = _build(
        tmp_path / "old.pdf",
        page_count=2,
        annots={2: [_annotation(nm="a1", contents="Old note")]},
    )
    new = _build(tmp_path / "new.pdf", page_count=1)

    result = diff_files(old, new)
    page = result["pages"][1]

    assert page["status"] == "removed"
    changes = _changes(result, 1)
    assert [(change["kind"], change["type"]) for change in changes] == [
        ("removed", "annotation")
    ]
    assert changes[0]["oldPage"] == 2
    assert changes[0]["newPage"] is None
    assert result["summary"]["resourcesRemoved"] == 1


# --- collector caps and skips ----------------------------------------------


def test_clean_resource_run_does_not_flag_truncation(tmp_path):
    old, new = _mixed_pair(tmp_path)

    result = diff_files(old, new)

    assert result["truncated"] is False
    assert result["summary"]["changesTruncated"] is False
    assert "resourcesTruncated" not in result["summary"]
    assert result["summary"]["resourcesMoved"] == 0


def test_annotation_page_cap_flags_the_result_as_incomplete(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_resources, "MAX_ANNOTATIONS_PER_PAGE", 1)
    old = _build(
        tmp_path / "old.pdf",
        annots={
            1: [
                _annotation(nm="a1", contents="Kept"),
                _annotation(nm="a2", contents="Dropped old"),
            ]
        },
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={
            1: [
                _annotation(nm="a1", contents="Kept"),
                _annotation(nm="a2", contents="Dropped new"),
            ]
        },
    )

    result = diff_files(old, new)

    # The capped annotation is dropped on both sides, so no change is reported.
    # Without the flags that would look like a clean comparison.
    assert _changes(result) == []
    assert result["truncated"] is True
    assert result["summary"]["changesTruncated"] is True
    assert result["summary"]["resourcesTruncated"] is True
    assert "resourcesAdded" not in result["summary"]


def test_form_cap_flags_the_result_as_incomplete(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_resources, "MAX_FORMS", 1)
    old = _build(
        tmp_path / "old.pdf",
        annots={
            1: [
                _widget(name="kept", value="Same"),
                _widget(name="dropped", value="Old", rect=b"[100 400 300 420]"),
            ]
        },
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={
            1: [
                _widget(name="kept", value="Same"),
                _widget(name="dropped", value="New", rect=b"[100 400 300 420]"),
            ]
        },
    )

    result = diff_files(old, new)

    assert _changes(result) == []
    assert result["truncated"] is True
    assert result["summary"]["resourcesTruncated"] is True


def test_metadata_cap_flags_truncation_only_when_metadata_is_compared(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(diff_resources, "MAX_METADATA_FIELDS", 1)
    old = _build(tmp_path / "old.pdf", metadata=b"<< /Title (Doc) >>")
    new = _build(
        tmp_path / "new.pdf",
        metadata=b"<< /Title (Doc) /Author (Ada) >>",
    )

    compared = diff_files(old, new)
    assert compared["summary"]["resourcesTruncated"] is True
    assert compared["truncated"] is True

    # An ignored kind is intentionally not compared: its cap cannot make the
    # compared result incomplete.
    ignored = diff_files(old, new, DiffOptions(ignore_metadata=True))
    assert "resourcesTruncated" not in ignored["summary"]
    assert ignored["truncated"] is False


def test_page_label_cap_flags_the_result_as_incomplete(tmp_path, monkeypatch):
    monkeypatch.setattr(diff_resources, "MAX_PAGE_LABELS", 1)
    labels = b"<< /Nums [0 << /S /r >> 1 << /S /D >>] >>"
    old = _build(
        tmp_path / "old.pdf",
        page_count=2,
        page_labels=labels,
        metadata=b"<< /Title (Old) >>",
    )
    new = _build(
        tmp_path / "new.pdf",
        page_count=2,
        page_labels=labels,
        metadata=b"<< /Title (New) >>",
    )

    result = diff_files(old, new)

    assert result["summary"]["resourcesTruncated"] is True
    assert result["truncated"] is True
    assert result["summary"]["changesTruncated"] is True


def _collector_note(bucket, key, count=1):
    return {bucket: {key: count}}


def test_resource_comparison_incomplete_reads_every_note():
    incomplete = diff_module.resource_comparison_incomplete
    every_page_kind_ignored = dict(
        ignore_annotations=True, ignore_links=True, ignore_forms=True
    )

    assert incomplete(None, None, DiffOptions()) is False
    assert incomplete(_collector_note("truncated", "annotations"), None, DiffOptions()) is True
    assert (
        incomplete(
            _collector_note("truncated", "annotationsPerPage"),
            None,
            DiffOptions(ignore_annotations=True),
        )
        is False
    )
    assert incomplete(None, _collector_note("skipped", "forms"), DiffOptions()) is True
    # A page-level block failing to parse degrades every compared page kind.
    assert incomplete(_collector_note("skipped", "pages"), None, DiffOptions()) is True
    assert (
        incomplete(
            _collector_note("skipped", "pages"),
            None,
            DiffOptions(**every_page_kind_ignored),
        )
        is False
    )
    # Destinations resolve internal link targets, so they belong to links.
    assert incomplete(_collector_note("truncated", "destinations"), None, DiffOptions()) is True
    assert (
        incomplete(
            _collector_note("truncated", "destinations"),
            None,
            DiffOptions(ignore_links=True),
        )
        is False
    )
    # An ignored kind never makes the compared result incomplete.
    assert (
        incomplete(
            _collector_note("truncated", "metadata"), None, DiffOptions(ignore_metadata=True)
        )
        is False
    )
    assert (
        incomplete(
            _collector_note("truncated", "pageLabels"),
            None,
            DiffOptions(ignore_page_labels=True),
        )
        is False
    )
    # Nothing compared at all: no collection, no truncation.
    assert (
        incomplete(
            _collector_note("truncated", "metadata"),
            None,
            DiffOptions(**every_page_kind_ignored, ignore_metadata=True, ignore_page_labels=True),
        )
        is False
    )
    # An unknown future reason stays conservative instead of claiming success.
    assert incomplete(_collector_note("truncated", "futureBlock"), None, DiffOptions()) is True
    # Zero counts are ignored.
    assert incomplete(_collector_note("truncated", "annotations", 0), None, DiffOptions()) is False


# --- cap, ordering and determinism -----------------------------------------


def test_resource_changes_share_the_change_cap(tmp_path):
    annots_old = [_annotation(nm=f"a{index}", contents="Old") for index in range(3)]
    annots_new = [_annotation(nm=f"a{index}", contents="New") for index in range(3)]
    old = _build(tmp_path / "old.pdf", annots={1: annots_old})
    new = _build(tmp_path / "new.pdf", annots={1: annots_new})

    monkeypatched = diff_module.MAX_DIFF_CHANGES
    diff_module.MAX_DIFF_CHANGES = 2
    try:
        result = diff_files(old, new)
    finally:
        diff_module.MAX_DIFF_CHANGES = monkeypatched

    assert len(_changes(result)) == 2
    assert result["truncated"] is True
    assert result["summary"]["changesTruncated"] is True
    assert result["summary"]["resourcesModified"] == 2


def test_ignoring_every_object_type_still_reports_resources(tmp_path):
    """Skipping object types must not look like a spent change budget."""
    old = _build(
        tmp_path / "old.pdf",
        annots={1: [_annotation(nm="a1", contents="Old note")]},
    )
    new = _build(
        tmp_path / "new.pdf",
        annots={1: [_annotation(nm="a1", contents="New note")]},
    )

    result = diff_files(old, new, DiffOptions(ignore_types=set(diff_module.DIFF_TYPES)))

    assert [change["type"] for change in _changes(result)] == ["annotation"]
    assert result["pages"][0]["status"] == "changed"
    assert result["truncated"] is False
    assert result["summary"]["changesTruncated"] is False


def test_object_changes_sort_before_resource_changes(tmp_path):
    def draw(canvas) -> None:
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 700, "Alpha")
        canvas.acroForm.textfield(
            name="person", value="Alice", x=100, y=200, width=150, height=20
        )

    def draw_new(canvas) -> None:
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 700, "Beta")
        canvas.acroForm.textfield(
            name="person", value="Bob", x=100, y=200, width=150, height=20
        )

    old = _reportlab_pdf(tmp_path / "old.pdf", draw)
    new = _reportlab_pdf(tmp_path / "new.pdf", draw_new)

    result = diff_files(old, new)
    types = [change["type"] for change in result["pages"][0]["changes"]]

    assert types[0] == "word"
    assert types[-1] == "form"
    assert types.index("word") < types.index("form")


def test_result_is_deterministic_and_contains_no_paths(tmp_path):
    old, new = _mixed_pair(tmp_path)

    first = diff_files(old, new)
    second = diff_files(old, new)

    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    payload = json.dumps(first, sort_keys=True)
    assert str(tmp_path) not in payload
    assert ".pdf" not in payload


def test_object_only_diff_keeps_the_historical_payload_shape(tmp_path):
    old = _text_pdf(tmp_path / "old.pdf", "Alpha")
    new = _text_pdf(tmp_path / "new.pdf", "Beta")

    result = diff_files(old, new)

    assert result["summary"]["objectsModified"] >= 1
    assert "documentChanges" not in result
    assert "resourcesAdded" not in result["summary"]
    assert "resourcesModified" not in result["summary"]
    assert "documentChanges" not in result["summary"]


def test_identical_files_skip_resource_collection(tmp_path):
    path = _build(
        tmp_path / "same.pdf",
        annots={1: [_annotation(nm="a1", contents="Note")]},
        metadata=b"<< /Title (Doc) >>",
    )

    result = diff_files(path, path)

    assert [page["status"] for page in result["pages"]] == ["unchanged"]
    assert "documentChanges" not in result
    assert "resourcesAdded" not in result["summary"]
