"""Session behaviour: opening a second document must not reuse the first one's data."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from extractor import PdfExtractor  # noqa: E402
from main import SidecarSession  # noqa: E402

SIDECAR_DIR = Path(__file__).resolve().parent.parent


def _write_pdf(path: Path, word: str) -> str:
    c = rl_canvas.Canvas(str(path), pagesize=letter)
    c.setFont("Helvetica", 12)
    c.drawString(72, 720, word)
    c.showPage()
    c.save()
    return str(path)


def _text_of(page_data: dict) -> str:
    return " ".join(w["text"] for w in page_data["words"])


@pytest.fixture()
def pdf_a(tmp_path):
    return _write_pdf(tmp_path / "a.pdf", "alphaword")


@pytest.fixture()
def pdf_b(tmp_path):
    return _write_pdf(tmp_path / "b.pdf", "betaword")


class FakeExtractor:
    """Stand-in for PdfExtractor that records calls without touching pdfplumber."""

    def __init__(self, path, password=None):
        self.path = path
        self.password = password
        self.closes = 0

    def get_metadata(self):
        return {"pages": 1, "title": self.path}

    def extract_page(self, page_num):
        return {"words": [{"text": Path(self.path).stem}], "page": page_num}

    def analyze_fonts(self):
        return {"fonts": []}

    def get_image_data(self, stream_id):
        return {"base64": "", "format": "png"}

    def close(self):
        self.closes += 1


def test_second_open_serves_the_second_document(pdf_a, pdf_b):
    session = SidecarSession()

    opened_a = session.handle("open", {"path": pdf_a}, request_id=1)
    assert "error" not in opened_a
    assert session.cache.get(1) is None

    first = session.handle("extract_page", {"page": 1}, request_id=2)
    assert "alphaword" in _text_of(first["result"])
    assert session.cache.get(1) is not None

    opened_b = session.handle("open", {"path": pdf_b}, request_id=3)
    assert "error" not in opened_b
    assert opened_b["result"]["pages"] == 1
    assert session.cache.get(1) is None, "page cache must be cleared when a new PDF opens"

    second = session.handle("extract_page", {"page": 1}, request_id=4)
    text = _text_of(second["result"])
    assert "betaword" in text
    assert "alphaword" not in text, "page 1 of B must not be served from A's cache"


def test_open_closes_the_previous_extractor(pdf_a, pdf_b, monkeypatch):
    closed = []
    original_close = PdfExtractor.close

    def spy_close(self):
        closed.append(self)
        original_close(self)

    monkeypatch.setattr(PdfExtractor, "close", spy_close)

    session = SidecarSession()
    session.handle("open", {"path": pdf_a}, request_id=1)
    assert closed == []

    session.handle("open", {"path": pdf_b}, request_id=2)
    assert len(closed) == 1


def test_injected_factory_extractor_is_closed_and_cache_cleared():
    created = []

    def factory(path, password=None):
        extractor = FakeExtractor(path, password)
        created.append(extractor)
        return extractor

    session = SidecarSession(extractor_factory=factory)
    session.handle("open", {"path": "a.pdf"}, request_id=1)
    page = session.handle("extract_page", {"page": 1}, request_id=2)
    assert page["result"]["words"][0]["text"] == "a"

    session.handle("open", {"path": "b.pdf"}, request_id=3)

    assert [e.path for e in created] == ["a.pdf", "b.pdf"]
    assert created[0].closes == 1
    assert session.cache.get(1) is None
    assert session.extractor is created[1]
    assert session.handle("extract_page", {"page": 1}, request_id=4)["result"]["words"][0]["text"] == "b"


def test_failing_close_does_not_break_open():
    class FailingClose(FakeExtractor):
        def close(self):
            raise RuntimeError("close failed")

    session = SidecarSession(extractor_factory=FailingClose)
    session.handle("open", {"path": "a.pdf"}, request_id=1)

    response = session.handle("open", {"path": "b.pdf"}, request_id=2)
    assert "error" not in response
    assert response["result"]["title"] == "b.pdf"


def test_shutdown_closes_document_and_flags_exit(pdf_a, monkeypatch):
    closed = []
    original_close = PdfExtractor.close

    def spy_close(self):
        closed.append(self)
        original_close(self)

    monkeypatch.setattr(PdfExtractor, "close", spy_close)

    session = SidecarSession()
    session.handle("open", {"path": pdf_a}, request_id=1)
    assert session.should_exit is False

    response = session.handle("shutdown", None, request_id=2)
    assert response == {"id": 2, "result": {}}
    assert len(closed) == 1
    assert session.extractor is None
    assert session.should_exit is True


def test_methods_without_open_document_report_no_pdf_open():
    session = SidecarSession()
    requests = [
        ("extract_page", {"page": 1}),
        ("extract_metadata", {}),
        ("analyze_fonts", {}),
        ("get_image_data", {"stream_id": "p1_img_0"}),
    ]
    for method, params in requests:
        assert session.handle(method, params, request_id=7) == {"id": 7, "error": "No PDF open"}


def test_unknown_method_error_text():
    assert SidecarSession().handle("bogus", {}, request_id=3) == {
        "id": 3,
        "error": "Unknown method: bogus",
    }


def test_open_failure_is_reported_as_an_error(tmp_path):
    response = SidecarSession().handle("open", {"path": str(tmp_path / "missing.pdf")}, request_id=5)
    assert response["id"] == 5
    assert "error" in response
    assert "result" not in response


def test_failed_open_never_serves_the_previous_document(pdf_a, tmp_path):
    session = SidecarSession()
    session.handle("open", {"path": pdf_a}, request_id=1)
    session.handle("extract_page", {"page": 1}, request_id=2)

    failed = session.handle("open", {"path": str(tmp_path / "missing.pdf")}, request_id=3)
    assert "error" in failed

    # The released document's pages must not come back from the cache.
    assert session.cache.get(1) is None
    assert session.handle("extract_page", {"page": 1}, request_id=4) == {
        "id": 4,
        "error": "No PDF open",
    }


def test_main_process_keeps_jsonrpc_protocol(pdf_a):
    """The real entry point still emits the ready line and {id, result}/{id, error} lines."""
    requests = [
        json.dumps({"id": 1, "method": "open", "params": {"path": pdf_a}}),
        json.dumps({"id": 2, "method": "extract_page", "params": {"page": 1}}),
        json.dumps({"id": 3, "method": "no_such_method", "params": {}}),
        json.dumps({"id": 4, "method": "shutdown", "params": {}}),
    ]
    completed = subprocess.run(
        [sys.executable, str(SIDECAR_DIR / "main.py")],
        input="\n".join(requests) + "\n",
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(SIDECAR_DIR),
    )

    lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert lines[0] == {"ready": True}
    assert lines[1]["id"] == 1
    assert lines[1]["result"]["pages"] == 1
    assert lines[2]["id"] == 2
    assert "alphaword" in _text_of(lines[2]["result"])
    assert lines[3] == {"id": 3, "error": "Unknown method: no_such_method"}
    assert lines[4] == {"id": 4, "result": {}}
    assert completed.returncode == 0
