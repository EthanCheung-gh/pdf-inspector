"""RPC transport for the diff engine: `diff_documents` dispatch behaviour."""

import sys
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from main import SidecarSession  # noqa: E402


def _write_pdf(path: Path, words, pagesize=letter) -> str:
    canvas = rl_canvas.Canvas(str(path), pagesize=pagesize)
    canvas.setFont("Helvetica", 12)
    for word in words:
        canvas.drawString(72, 720, word)
        canvas.showPage()
    canvas.save()
    return str(path)


@pytest.fixture()
def old_pdf(tmp_path):
    return _write_pdf(tmp_path / "old.pdf", ["alphaword"])


@pytest.fixture()
def new_pdf(tmp_path):
    return _write_pdf(tmp_path / "new.pdf", ["alphaword", "betaword"])


def _diff(session, old_path, new_path, options=None, request_id=9):
    params = {"old_path": old_path, "new_path": new_path}
    if options is not None:
        params["options"] = options
    return session.handle("diff_documents", params, request_id=request_id)


def test_diff_documents_works_without_an_open_document(old_pdf, new_pdf):
    response = _diff(SidecarSession(), old_pdf, new_pdf)

    assert "error" not in response
    result = response["result"]
    assert result["schemaVersion"] == 1
    assert result["tool"]["name"] == "pdf-inspector"
    assert result["old"]["pages"] == 1
    assert result["new"]["pages"] == 2
    assert result["summary"]["pagesAdded"] == 1
    # Every object of the inserted page (word, chars, ...) is reported as added.
    assert result["summary"]["objectsAdded"] > 0
    assert [page["status"] for page in result["pages"]] == ["unchanged", "added"]


def test_diff_documents_leaves_the_session_document_untouched(old_pdf, new_pdf):
    session = SidecarSession()
    opened = session.handle("open", {"path": old_pdf}, request_id=1)
    assert "error" not in opened
    page = session.handle("extract_page", {"page": 1}, request_id=2)
    assert "alphaword" in " ".join(word["text"] for word in page["result"]["words"])

    extractor_before = session.extractor
    cached_before = session.cache.get(1)

    response = _diff(session, old_pdf, new_pdf)

    assert "error" not in response
    assert session.extractor is extractor_before
    assert session.cache.get(1) is cached_before
    # The open document still serves its own page, not a diff extractor's data.
    after = session.handle("extract_page", {"page": 1}, request_id=3)
    assert "alphaword" in " ".join(word["text"] for word in after["result"]["words"])


def test_diff_documents_forwards_snake_case_options_and_echoes_camel_case(
    old_pdf, new_pdf
):
    response = _diff(
        SidecarSession(),
        old_pdf,
        new_pdf,
        {
            "position_tolerance": 2.5,
            "text_tolerance": "exact",
            "ignore_types": ["word"],
            "ignore_fonts": True,
            "ignore_colors": True,
        },
    )

    assert "error" not in response
    result = response["result"]
    assert result["options"] == {
        "positionTolerance": 2.5,
        "textTolerance": "exact",
        "ignoreTypes": ["word"],
        "ignoreFonts": True,
        "ignoreColors": True,
        "ignoreImages": False,
    }
    # Ignoring words must actually reach the engine: a text-only change on a
    # paired page then reports nothing.
    first_page = result["pages"][0]
    assert first_page["status"] == "unchanged"
    assert first_page["changes"] == []


def test_diff_documents_omitted_options_use_defaults(old_pdf, new_pdf):
    result = _diff(SidecarSession(), old_pdf, new_pdf)["result"]

    assert result["options"]["positionTolerance"] == 1.0
    assert result["options"]["textTolerance"] == "normalized"
    assert result["options"]["ignoreTypes"] == []


def test_diff_documents_requires_both_paths():
    session = SidecarSession()

    assert session.handle("diff_documents", {}, request_id=4) == {
        "id": 4,
        "error": '"old_path" must be a non-empty file path',
    }
    assert session.handle("diff_documents", {"old_path": "a.pdf"}, request_id=5) == {
        "id": 5,
        "error": '"new_path" must be a non-empty file path',
    }
    assert session.handle(
        "diff_documents", {"old_path": "a.pdf", "new_path": "   "}, request_id=6
    ) == {"id": 6, "error": '"new_path" must be a non-empty file path'}


def test_diff_documents_reports_an_unreadable_pdf_as_a_clean_error(tmp_path, new_pdf):
    missing = str(tmp_path / "missing.pdf")

    response = _diff(SidecarSession(), missing, new_pdf)

    assert "result" not in response
    assert "Cannot read old PDF" in response["error"]
    assert "Traceback" not in response["error"]


def test_diff_documents_rejects_invalid_options(old_pdf, new_pdf):
    session = SidecarSession()

    numeric = _diff(session, old_pdf, new_pdf, {"position_tolerance": "wide"})
    assert "position_tolerance must be a number" in numeric["error"]

    tolerance = _diff(session, old_pdf, new_pdf, {"text_tolerance": "fuzzy"})
    assert "text_tolerance must be one of" in tolerance["error"]

    types = _diff(session, old_pdf, new_pdf, {"ignore_types": ["bogus"]})
    assert "Unknown ignore type(s): bogus" in types["error"]

    shape = _diff(session, old_pdf, new_pdf, {"ignore_types": "word"})
    assert shape["error"] == '"ignore_types" must be an array of object types'


def test_diff_documents_rejects_camel_case_and_unknown_options(old_pdf, new_pdf):
    response = _diff(SidecarSession(), old_pdf, new_pdf, {"positionTolerance": 1.0})

    assert response["error"].startswith("Unknown diff option(s): positionTolerance")
    assert "position_tolerance" in response["error"]


def test_diff_documents_requires_an_options_object(old_pdf, new_pdf):
    response = _diff(SidecarSession(), old_pdf, new_pdf, ["position_tolerance"])

    assert response["error"] == '"options" must be an object'
