"""The committed diff-resource sample pair and its generator.

The generator is pinned end to end: it must be byte-deterministic, reproduce the
committed fixtures, open in pdfplumber/PDF.js-compatible readers, and drive the
sidecar and CLI to a resource-only diff.  Both pages have identical geometry and
content streams, so every reported change must be a document resource
(annotation, link, form, metadata, page label) and the object counters must stay
zero.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from diff import DiffOptions, diff_files  # noqa: E402
from extractor import PdfExtractor  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLES = REPO_ROOT / "web-samples"
GENERATOR = REPO_ROOT / "scripts" / "generate-diff-resource-samples.py"
CLI = REPO_ROOT / "sidecar" / "cli.py"
OLD = SAMPLES / "diff-resources-old.pdf"
NEW = SAMPLES / "diff-resources-new.pdf"


def _load_generator():
    spec = importlib.util.spec_from_file_location(
        "generate_diff_resource_samples", GENERATOR
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _require_samples() -> None:
    if not OLD.exists() or not NEW.exists():
        pytest.skip(
            "web-samples/diff-resources-*.pdf are missing; run "
            "scripts/generate-diff-resource-samples.py"
        )


def _page_changes(result, page_index: int = 0):
    return result["pages"][page_index]["changes"]


def _document_changes(result, type_: str | None = None):
    return [
        change
        for change in result.get("documentChanges") or ()
        if type_ is None or change["type"] == type_
    ]


# --- generator determinism and committed fixtures ---------------------------


def test_generator_is_deterministic_and_matches_the_committed_samples(tmp_path):
    module = _load_generator()

    assert module.build_old_pdf() == module.build_old_pdf()
    assert module.build_new_pdf() == module.build_new_pdf()

    first = module.write_samples(tmp_path / "first")
    second = module.write_samples(tmp_path / "second")

    assert [path.name for path in first] == [module.OLD_NAME, module.NEW_NAME]
    assert [path.name for path in second] == [module.OLD_NAME, module.NEW_NAME]
    for left, right in zip(first, second):
        assert left.read_bytes() == right.read_bytes()

    _require_samples()
    assert first[0].read_bytes() == OLD.read_bytes()
    assert first[1].read_bytes() == NEW.read_bytes()


# --- real readers -----------------------------------------------------------


def test_samples_open_in_pdfplumber():
    _require_samples()
    import pdfplumber

    for path, title in (
        (OLD, "Diff Resources Sample - Revision A"),
        (NEW, "Diff Resources Sample - Revision B"),
    ):
        with pdfplumber.open(str(path)) as pdf:
            assert len(pdf.pages) == 2
            assert pdf.metadata["Title"] == title
            text = pdf.pages[0].extract_text() or ""
            assert "diff resources sample" in text
            assert "customer_name" in text


def test_samples_open_and_extract_text_through_the_sidecar():
    _require_samples()

    for path in (OLD, NEW):
        extractor = PdfExtractor(str(path))
        try:
            metadata = extractor.get_metadata()
            page_one = extractor.extract_page(1)
            page_two = extractor.extract_page(2)
        finally:
            extractor.close()

        assert metadata["pages"] == 2
        assert page_one["width"] == page_two["width"] == 612
        assert page_one["height"] == page_two["height"] == 792
        text = "".join(char["text"] for char in page_one["chars"])
        assert "diff resources sample" in text


# --- diff engine ------------------------------------------------------------


def test_diff_reports_only_resources_and_document_changes():
    _require_samples()

    result = diff_files(str(OLD), str(NEW))
    summary = result["summary"]

    # The object side is empty: identical content streams and geometry.
    assert summary["objectsAdded"] == 0
    assert summary["objectsRemoved"] == 0
    assert summary["objectsMoved"] == 0
    assert summary["objectsModified"] == 0
    assert summary["pagesAdded"] == 0
    assert summary["pagesRemoved"] == 0
    assert summary["pagesChanged"] == 1
    assert summary["pagesReordered"] == 0

    # Three modified page resources: annotation, link and form.
    assert summary["resourcesAdded"] == 0
    assert summary["resourcesRemoved"] == 0
    assert summary["resourcesModified"] == 3
    assert summary["documentChanges"] == 3

    assert [page["status"] for page in result["pages"]] == ["changed", "unchanged"]
    assert result["pages"][1]["changes"] == []

    page_types = {change["type"] for change in _page_changes(result)}
    assert page_types == {"annotation", "link", "form"}
    by_type = {change["type"]: change for change in _page_changes(result)}

    annotation = by_type["annotation"]
    assert annotation["kind"] == "modified"
    assert annotation["details"]["identity"] == "ann:nm:note-review"
    assert annotation["details"]["color"] == {
        "old": [1.0, 0.92, 0.35],
        "new": [0.85, 0.92, 1.0],
    }
    assert annotation["textOld"].startswith("Reviewed in revision A")
    assert annotation["textNew"].startswith("Reviewed in revision B")

    link = by_type["link"]
    assert link["kind"] == "modified"
    assert link["details"]["identity"] == "link:nm:link-docs"
    assert link["details"]["uri"] == {
        "old": "https://example.com/docs/v1",
        "new": "https://example.com/docs/v2",
    }
    assert link["textOld"] == "https://example.com/docs/v1"
    assert link["textNew"] == "https://example.com/docs/v2"

    form = by_type["form"]
    assert form["kind"] == "modified"
    assert form["details"]["identity"].startswith("form:field=customer_name|rect=")
    assert form["details"]["value"] == {"old": "Alice", "new": "Bob"}
    # Field type, name, default and flags are identical, so only the value is
    # reported.
    assert set(form["details"]) == {"resource", "identity", "value"}
    assert form["textOld"] == "Alice"
    assert form["textNew"] == "Bob"

    metadata = {
        change["field"]: change for change in _document_changes(result, "metadata")
    }
    assert set(metadata) == {"title", "author"}
    assert metadata["title"]["oldValue"] == "Diff Resources Sample - Revision A"
    assert metadata["title"]["newValue"] == "Diff Resources Sample - Revision B"
    assert metadata["author"]["oldValue"] == "Alice Example"
    assert metadata["author"]["newValue"] == "Bob Example"

    labels = _document_changes(result, "page-label")
    assert len(labels) == 1
    label = labels[0]
    assert label["page"] == 1
    assert label["field"] == "page-label"
    assert (label["oldValue"], label["newValue"]) == ("i", "ii")
    assert label["details"] == {"start": {"old": 1, "new": 2}}


def test_ignoring_every_resource_kind_yields_an_empty_diff():
    _require_samples()

    result = diff_files(
        str(OLD),
        str(NEW),
        DiffOptions(
            ignore_annotations=True,
            ignore_links=True,
            ignore_forms=True,
            ignore_metadata=True,
            ignore_page_labels=True,
        ),
    )

    assert not any(result["summary"].values()), result["summary"]
    assert "documentChanges" not in result
    assert [page["status"] for page in result["pages"]] == ["unchanged", "unchanged"]
    assert all(not page["changes"] for page in result["pages"])


# --- CLI --------------------------------------------------------------------


def _run_cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def test_cli_json_summary_and_html_describe_the_resource_diff(tmp_path):
    _require_samples()

    json_path = tmp_path / "resources.json"
    failing = _run_cli(
        "diff",
        str(OLD),
        str(NEW),
        "--format",
        "json",
        "--output",
        str(json_path),
        "--fail-on",
        "any",
        "--quiet",
    )

    assert failing.returncode == 1, failing.stderr
    data = json.loads(json_path.read_text(encoding="utf-8"))
    assert data["summary"]["resourcesModified"] == 3
    assert data["summary"]["documentChanges"] == 3
    assert data["summary"]["objectsModified"] == 0

    summary = _run_cli("diff", str(OLD), str(NEW), "--fail-on", "none")
    assert summary.returncode == 0, summary.stderr
    assert "resources: 0 added, 0 removed, 3 modified" in summary.stdout
    assert "document changes: 3" in summary.stdout
    assert "annotation modified" in summary.stdout
    assert "link modified" in summary.stdout
    assert "form modified" in summary.stdout
    assert "metadata title modified" in summary.stdout
    assert 'page-label page-label modified "i" -> "ii" (page 1)' in summary.stdout

    html = _run_cli("diff", str(OLD), str(NEW), "--format", "html", "--fail-on", "none")
    assert html.returncode == 0, html.stderr
    assert html.stdout.startswith("<!DOCTYPE html>")
    assert "Document changes" in html.stdout
    assert "Page label" in html.stdout
    assert "Annotation" in html.stdout
    assert "https://example.com/docs/v1" in html.stdout
    assert "https://example.com/docs/v2" in html.stdout
    assert "<script" not in html.stdout


def test_cli_ignore_flags_yield_exit_zero_and_no_changes(tmp_path):
    _require_samples()

    json_path = tmp_path / "resources-ignored.json"
    result = _run_cli(
        "diff",
        str(OLD),
        str(NEW),
        "--format",
        "json",
        "--output",
        str(json_path),
        "--fail-on",
        "any",
        "--quiet",
        "--ignore-annotations",
        "--ignore-links",
        "--ignore-forms",
        "--ignore-metadata",
        "--ignore-page-labels",
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(json_path.read_text(encoding="utf-8"))
    assert not any(data["summary"].values()), data["summary"]
    assert "documentChanges" not in data
    assert data["options"]["ignoreAnnotations"] is True
    assert data["options"]["ignorePageLabels"] is True
