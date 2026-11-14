"""Directory audit discovery and aggregation: rules, limits, counts, determinism.

The discovery tests build tiny trees with a hand-written ``%PDF-1.4`` file, so
each case states exactly which entries must survive the rules; the aggregation
tests use that same minimal PDF plus one committed sample, because a real
finding set (warnings, fingerprints, document metadata) is what has to survive
aggregation unchanged.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import audit  # noqa: E402
from batch_audit import (  # noqa: E402
    BATCH_SCHEMA_VERSION,
    MAX_FILES_LIMIT,
    BatchAuditError,
    BatchEntry,
    audit_directory,
    discover_pdfs,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
# A committed sample, so this file also runs in CI before
# `scripts/generate-web-samples.py` creates the ignored web samples.
BROKEN_SAMPLE = REPO_ROOT / "web-samples" / "accessibility-broken.pdf"

# The smallest PDF pdfminer opens: one page, no metadata, no structure tree, so
# the audit is fast and its findings are fixed (five ``info`` entries).
MINIMAL_PDF = b"""%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
trailer << /Root 1 0 R /Size 4 >>
%%EOF
"""

BROKEN_PDF = b"%PDF-1.4\nthis header promises a document body that never arrives\n"

# A timestamp anywhere in the payload would break byte-for-byte determinism.
TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")

HEX32 = re.compile(r"[0-9a-f]{32}")

ZERO_SUMMARY = {
    "files": 0,
    "audited": 0,
    "failed": 0,
    "findings": 0,
    "errors": 0,
    "warnings": 0,
    "info": 0,
}


# --- fixture builders -------------------------------------------------------


def _pdf(path: Path) -> Path:
    """Write a minimal valid PDF at ``path``, creating parent directories."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(MINIMAL_PDF)
    return path


def _broken(path: Path) -> Path:
    """Write a file that looks like a PDF but has no document body."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(BROKEN_PDF)
    return path


def _paths(entries: list[BatchEntry]) -> list[str]:
    return [entry.path for entry in entries]


def _can_symlink() -> bool:
    return hasattr(os, "symlink")


# --- discovery rules --------------------------------------------------------


def test_discovers_nested_pdfs_and_ignores_other_suffixes(tmp_path):
    _pdf(tmp_path / "a.pdf")
    _pdf(tmp_path / "reports" / "b.pdf")
    _pdf(tmp_path / "reports" / "2024" / "c.Pdf")
    _pdf(tmp_path / "REPORTS" / "D.PDF")
    (tmp_path / "notes.txt").write_text("not a PDF")
    (tmp_path / "reports" / "b.pdf.bak").write_bytes(b"%PDF-1.4\n")
    (tmp_path / "cover.png").write_bytes(b"png")

    assert _paths(discover_pdfs(tmp_path)) == [
        "a.pdf",
        "reports/2024/c.Pdf",
        "reports/b.pdf",
        "REPORTS/D.PDF",
    ]


def test_skips_hidden_files_and_directories_and_tool_directories(tmp_path):
    root = tmp_path / "root"
    _pdf(root / "keep.pdf")
    _pdf(root / "sub" / "keep2.pdf")
    _pdf(root / ".hidden" / "a.pdf")
    _pdf(root / ".git" / "b.pdf")
    _pdf(root / ".venv" / "c.pdf")
    _pdf(root / "node_modules" / "pkg" / "d.pdf")
    _pdf(root / "vendored" / "node_modules" / "e.pdf")
    _pdf(root / "__pycache__" / "f.pdf")
    _pdf(root / ".hg" / "g.pdf")
    _pdf(root / ".svn" / "h.pdf")
    _pdf(root / ".dot.pdf")
    _pdf(root / "sub" / ".dot2.pdf")

    assert _paths(discover_pdfs(root)) == ["keep.pdf", "sub/keep2.pdf"]


@pytest.mark.skipif(not _can_symlink(), reason="platform cannot create symlinks")
def test_symlinked_files_and_directories_are_never_followed(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    _pdf(root / "real.pdf")
    _pdf(outside / "linked.pdf")
    try:
        (root / "alias.pdf").symlink_to(outside / "linked.pdf")
        (root / "linked-dir").symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("platform cannot create symlinks")

    assert _paths(discover_pdfs(root)) == ["real.pdf"]


def test_entries_expose_a_relative_path_and_an_internal_absolute_handle(tmp_path):
    _pdf(tmp_path / "reports" / "a.pdf")

    (entry,) = discover_pdfs(tmp_path)

    assert entry.path == "reports/a.pdf"
    assert entry.size == len(MINIMAL_PDF)
    assert entry.absolute.is_absolute()
    assert entry.absolute.name == "a.pdf"
    assert entry.absolute.read_bytes() == MINIMAL_PDF
    # ``absolute`` is internal only: a frozen dataclass keeps it unswappable.
    with pytest.raises(FrozenInstanceError):
        entry.absolute = tmp_path  # type: ignore[misc]


def test_empty_directory_is_a_valid_empty_discovery(tmp_path):
    assert discover_pdfs(tmp_path) == []


def test_files_are_ordered_by_casefolded_path_then_exact_text(tmp_path):
    for name in ("b.pdf", "A.pdf", "a.pdf", "B.pdf", "z/c.pdf", "z/A.pdf"):
        _pdf(tmp_path / name)

    assert _paths(discover_pdfs(tmp_path)) == [
        "A.pdf",
        "a.pdf",
        "B.pdf",
        "b.pdf",
        "z/A.pdf",
        "z/c.pdf",
    ]


# --- file names that are not valid UTF-8 ------------------------------------


def _invalid_utf8_pdf(root: Path, payload: bytes = MINIMAL_PDF) -> Path:
    """Write a PDF under a file name that is not valid UTF-8, or skip.

    POSIX file names are bytes: a lone ``\\xff`` is not UTF-8, so the name
    decodes into the surrogate ``'bad\\udcff.pdf'``.  A platform that cannot
    represent the name (or silently re-encodes it) cannot exercise the rule.
    """
    path = root / os.fsdecode(b'bad\xff.pdf')
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.write_bytes(payload)
    except (OSError, UnicodeError):  # pragma: no cover - platform dependent
        pytest.skip('platform cannot create a non-UTF-8 file name')
    if os.fsencode(path.name) != b'bad\xff.pdf':  # pragma: no cover
        pytest.skip('platform re-encoded the non-UTF-8 file name')
    return path


def test_a_non_utf8_file_name_is_sanitised_and_still_audited(tmp_path):
    root = tmp_path / "docs"
    _pdf(root / "ok.pdf")
    raw = _invalid_utf8_pdf(root)

    seen: list[str] = []
    result = audit_directory(
        root, progress=lambda done, total, path: seen.append(path)
    )

    # The whole payload must be UTF-8 text; a lone surrogate would raise here.
    json.dumps(result, indent=2, ensure_ascii=False).encode("utf-8")

    assert [entry["path"] for entry in result["files"]] == [
        "bad\\udcff.pdf",
        "ok.pdf",
    ]
    assert seen == ["bad\\udcff.pdf", "ok.pdf"]
    assert result["summary"]["files"] == 2
    assert result["summary"]["audited"] == 2
    assert result["summary"]["failed"] == 0
    assert result["root"]["bytes"] == 2 * len(MINIMAL_PDF)

    entries = discover_pdfs(root)
    assert _paths(entries) == ["bad\\udcff.pdf", "ok.pdf"]
    for entry in entries:
        entry.path.encode("utf-8")
        assert entry.absolute.read_bytes() == MINIMAL_PDF
    # The internal handle keeps the raw name, so the real file was audited.
    assert os.fsencode(entries[0].absolute.name) == b"bad\xff.pdf"
    assert entries[0].absolute.samefile(raw)
    # Globs match what the payload shows, which is the only spellable form.
    assert _paths(discover_pdfs(root, include=["bad*"])) == ["bad\\udcff.pdf"]


def test_a_non_utf8_file_name_error_stays_encodable(tmp_path):
    root = tmp_path / "docs"
    _invalid_utf8_pdf(root, payload=BROKEN_PDF)

    result = audit_directory(root)

    (entry,) = result["files"]
    assert entry["status"] == "error"
    assert "bad\\udcff.pdf" in entry["error"]
    assert str(root) not in entry["error"]
    assert result["summary"]["failed"] == 1
    assert result["summary"]["errors"] == 1
    json.dumps(result, ensure_ascii=False).encode("utf-8")


# --- include / exclude ------------------------------------------------------


def test_include_globs_are_ored_and_exclude_always_wins(tmp_path):
    for name in ("a.pdf", "b.pdf", "slide.pdf", "reports/c.pdf", "reports/draft/d.pdf"):
        _pdf(tmp_path / name)

    # A bare string is one pattern, not a sequence of characters.
    assert _paths(discover_pdfs(tmp_path, include="reports/*")) == [
        "reports/c.pdf",
        "reports/draft/d.pdf",
    ]
    assert _paths(discover_pdfs(tmp_path, include=["a.pdf", "slide.pdf"])) == [
        "a.pdf",
        "slide.pdf",
    ]
    # Empty include means "every PDF"; the pattern matches across ``/``.
    assert _paths(discover_pdfs(tmp_path, include=["*.pdf"])) == [
        "a.pdf",
        "b.pdf",
        "reports/c.pdf",
        "reports/draft/d.pdf",
        "slide.pdf",
    ]
    filtered = discover_pdfs(tmp_path, include=["*.pdf"], exclude=["reports/*"])
    assert _paths(filtered) == ["a.pdf", "b.pdf", "slide.pdf"]
    assert _paths(discover_pdfs(tmp_path, exclude=["*.pdf"])) == []


def test_globs_match_the_relative_posix_path_case_sensitively(tmp_path):
    _pdf(tmp_path / "upper.PDF")
    _pdf(tmp_path / "reports" / "nested.pdf")

    assert _paths(discover_pdfs(tmp_path, include=["*.PDF"])) == ["upper.PDF"]
    nested = discover_pdfs(tmp_path, include=["reports/*"])
    assert _paths(nested) == ["reports/nested.pdf"]
    # Patterns are matched against the relative path, never the bare filename.
    assert _paths(discover_pdfs(tmp_path, include=["nested.pdf"])) == []


# --- max_files --------------------------------------------------------------


def test_max_files_allows_equality_and_reports_the_found_count(tmp_path):
    for index in range(3):
        _pdf(tmp_path / f"{index}.pdf")

    assert len(discover_pdfs(tmp_path, max_files=3)) == 3
    with pytest.raises(BatchAuditError) as error:
        discover_pdfs(tmp_path, max_files=2)
    message = str(error.value)
    assert "found 3 PDF files" in message
    assert "limit of 2" in message


@pytest.mark.parametrize(
    "value", [0, -1, MAX_FILES_LIMIT + 1, 10_000, "500", 2.5, None, True]
)
def test_invalid_max_files_is_rejected(tmp_path, value):
    _pdf(tmp_path / "a.pdf")

    with pytest.raises(BatchAuditError, match="max_files"):
        discover_pdfs(tmp_path, max_files=value)
    with pytest.raises(BatchAuditError, match="max_files"):
        audit_directory(tmp_path, max_files=value)


def test_max_files_bounds_are_accepted(tmp_path):
    _pdf(tmp_path / "a.pdf")

    assert len(discover_pdfs(tmp_path, max_files=1)) == 1
    assert len(discover_pdfs(tmp_path, max_files=MAX_FILES_LIMIT)) == 1


# --- root validation --------------------------------------------------------


@pytest.mark.parametrize(
    "root",
    [
        "https://example.com/docs",
        "http://localhost:8000/docs",
        "file:///srv/docs",
    ],
)
def test_url_root_is_rejected(root):
    with pytest.raises(BatchAuditError, match="not a URL"):
        discover_pdfs(root)
    with pytest.raises(BatchAuditError, match="not a URL"):
        audit_directory(root)


def test_empty_root_is_rejected():
    with pytest.raises(BatchAuditError, match="empty path"):
        discover_pdfs("")


def test_missing_file_and_nonexistent_roots_are_rejected(tmp_path):
    _pdf(tmp_path / "a.pdf")

    with pytest.raises(BatchAuditError, match="does not exist"):
        discover_pdfs(tmp_path / "missing")
    with pytest.raises(BatchAuditError, match="not a directory"):
        discover_pdfs(tmp_path / "a.pdf")
    with pytest.raises(BatchAuditError, match="must be a local directory"):
        discover_pdfs(None)
    with pytest.raises(BatchAuditError, match="does not exist"):
        audit_directory(tmp_path / "missing")


def test_unreadable_root_is_rejected(tmp_path):
    if getattr(os, "geteuid", lambda: 1)() == 0:
        pytest.skip("root ignores directory permissions")
    root = tmp_path / "locked"
    _pdf(root / "a.pdf")
    root.chmod(0o000)
    try:
        with pytest.raises(BatchAuditError, match="not readable"):
            discover_pdfs(root)
    finally:
        root.chmod(0o755)


def test_unreadable_subdirectory_aborts_discovery_instead_of_skipping_it(tmp_path):
    if getattr(os, "geteuid", lambda: 1)() == 0:
        pytest.skip("root ignores directory permissions")
    hidden = tmp_path / "private"
    _pdf(tmp_path / "a.pdf")
    _pdf(hidden / "b.pdf")
    hidden.chmod(0o000)
    try:
        with pytest.raises(BatchAuditError, match="cannot read directory"):
            discover_pdfs(tmp_path)
    finally:
        hidden.chmod(0o755)


def test_root_name_is_the_directory_basename_not_the_path(tmp_path, monkeypatch):
    root = tmp_path / "docs"
    _pdf(root / "a.pdf")
    monkeypatch.chdir(root)

    result = audit_directory(".")

    assert result["root"]["name"] == "docs"
    assert result["files"][0]["path"] == "a.pdf"
    assert str(tmp_path) not in json.dumps(result)


# --- aggregation ------------------------------------------------------------


def test_aggregates_ok_and_failed_files_without_aborting(tmp_path):
    root = tmp_path / "docs"
    ok_path = root / "ok.pdf"
    ok_path.parent.mkdir(parents=True, exist_ok=True)
    ok_path.write_bytes(BROKEN_SAMPLE.read_bytes())
    broken_path = _broken(root / "broken.pdf")

    calls: list[tuple[int, int, str]] = []
    result = audit_directory(
        root, progress=lambda done, total, path: calls.append((done, total, path))
    )

    assert [entry["path"] for entry in result["files"]] == ["broken.pdf", "ok.pdf"]
    failed, ok = result["files"]

    # The progress hook runs before each file with the completed count.
    assert calls == [(0, 2, "broken.pdf"), (1, 2, "ok.pdf")]

    report = audit.audit_file(ok_path)
    assert ok == {
        "path": "ok.pdf",
        "status": "ok",
        "bytes": ok_path.stat().st_size,
        "document": report["document"],
        "summary": report["summary"],
        "findings": report["findings"],
    }
    assert ok["document"]["title"] == "Accessibility sample - broken"

    assert set(failed) == {"path", "status", "bytes", "error"}
    assert failed["path"] == "broken.pdf"
    assert failed["status"] == "error"
    assert failed["bytes"] == broken_path.stat().st_size
    assert "Cannot open PDF" in failed["error"]
    assert "broken.pdf" in failed["error"]
    assert str(root) not in failed["error"]
    assert "\n" not in failed["error"]
    assert failed["error"] == failed["error"].strip()

    summary = result["summary"]
    assert summary["files"] == 2
    assert summary["audited"] == 1
    assert summary["failed"] == 1
    assert summary["findings"] == report["summary"]["total"]
    assert summary["errors"] == report["summary"]["errors"] + 1
    assert summary["warnings"] == report["summary"]["warnings"]
    assert summary["info"] == report["summary"]["info"]

    assert result["schemaVersion"] == BATCH_SCHEMA_VERSION == 1
    assert result["tool"] == audit.tool()
    assert result["root"] == {
        "name": "docs",
        "files": 2,
        "bytes": ok_path.stat().st_size + broken_path.stat().st_size,
    }


def test_audit_directory_preserves_full_findings_and_document_info(tmp_path):
    root = tmp_path / "docs"
    path = root / "ok.pdf"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(BROKEN_SAMPLE.read_bytes())

    (entry,) = audit_directory(root)["files"]
    report = audit.audit_file(path)

    assert entry["status"] == "ok"
    assert entry["document"] == report["document"]
    assert entry["document"]["tagged"] is True
    assert entry["summary"] == report["summary"]
    assert entry["findings"] == report["findings"]
    assert entry["findings"]
    for finding in entry["findings"]:
        assert set(finding) == set(audit.FINDING_OUTPUT_KEYS)
        assert HEX32.fullmatch(finding["fingerprint"])


def test_audit_directory_honours_include_and_exclude(tmp_path):
    root = tmp_path / "docs"
    _pdf(root / "top.pdf")
    _pdf(root / "reports" / "a.pdf")
    _pdf(root / "reports" / "draft" / "b.pdf")

    result = audit_directory(root, include=["reports/*"], exclude=["reports/draft/*"])

    assert [entry["path"] for entry in result["files"]] == ["reports/a.pdf"]
    assert result["summary"]["files"] == 1
    assert result["root"]["files"] == 1


def test_audit_directory_rejects_a_tree_over_the_limit(tmp_path):
    root = tmp_path / "docs"
    for index in range(2):
        _pdf(root / f"{index}.pdf")

    with pytest.raises(BatchAuditError, match="found 2 PDF files"):
        audit_directory(root, max_files=1)


def test_empty_directory_produces_an_empty_batch(tmp_path):
    result = audit_directory(tmp_path)

    assert result["files"] == []
    assert result["root"] == {"name": tmp_path.name, "files": 0, "bytes": 0}
    assert result["summary"] == ZERO_SUMMARY


def test_progress_callback_errors_never_break_the_audit(tmp_path):
    root = tmp_path / "docs"
    _pdf(root / "a.pdf")
    _broken(root / "b.pdf")

    def broken_progress(done, total, path):
        raise RuntimeError("the progress bar exploded")

    result = audit_directory(root, progress=broken_progress)

    assert result["summary"]["files"] == 2
    assert result["summary"]["failed"] == 1
    assert result["summary"]["audited"] == 1


def test_progress_must_be_callable(tmp_path):
    _pdf(tmp_path / "a.pdf")

    with pytest.raises(BatchAuditError, match="progress must be callable"):
        audit_directory(tmp_path, progress="verbose")


def test_a_file_that_disappears_during_the_audit_becomes_a_per_file_error(tmp_path):
    root = tmp_path / "docs"
    _pdf(root / "a.pdf")
    victim = _pdf(root / "b.pdf")

    def progress(done, total, path):
        if path == "b.pdf":
            victim.unlink()

    result = audit_directory(root, progress=progress)

    ok, failed = result["files"]
    assert ok["status"] == "ok"
    assert failed["status"] == "error"
    assert failed["bytes"] == len(MINIMAL_PDF)
    assert "b.pdf" in failed["error"]
    assert str(root) not in failed["error"]
    assert result["summary"]["audited"] == 1
    assert result["summary"]["failed"] == 1
    assert result["summary"]["errors"] == 1
    # Discovery sizes survive: both files were present when the batch started.
    assert result["root"]["bytes"] == 2 * len(MINIMAL_PDF)


# --- determinism ------------------------------------------------------------


def test_two_runs_serialise_byte_identically_without_locations(tmp_path):
    root = tmp_path / "docs"
    _pdf(root / "a.pdf")
    _pdf(root / "sub" / "b.PDF")
    _broken(root / "sub" / "c.pdf")
    _pdf(root / "z.pdf")

    first = json.dumps(audit_directory(root), sort_keys=False)
    second = json.dumps(audit_directory(root), sort_keys=False)

    assert first == second
    assert str(root) not in first
    assert str(tmp_path) not in first
    assert "\\" not in first  # only POSIX separators reach the payload
    assert "sub/b.PDF" in first
    assert not TIMESTAMP.search(first)

    payload = json.loads(first)
    assert list(payload) == ["schemaVersion", "tool", "root", "summary", "files"]
    assert list(payload["tool"]) == ["name", "version"]
    assert list(payload["root"]) == ["name", "files", "bytes"]
    assert list(payload["summary"]) == [
        "files",
        "audited",
        "failed",
        "findings",
        "errors",
        "warnings",
        "info",
    ]
    assert [entry["path"] for entry in payload["files"]] == [
        "a.pdf",
        "sub/b.PDF",
        "sub/c.pdf",
        "z.pdf",
    ]
    for entry in payload["files"]:
        if entry["status"] == "ok":
            assert list(entry) == [
                "path",
                "status",
                "bytes",
                "document",
                "summary",
                "findings",
            ]
        else:
            assert list(entry) == ["path", "status", "bytes", "error"]
        assert not Path(entry["path"]).is_absolute()
