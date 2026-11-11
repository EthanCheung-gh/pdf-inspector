"""Heartbeat lines keep one long diff page from looking like an idle request.

The parent's request budget is rearmed by every ``{"id", "progress"}`` line. A
diff reports one progress line per page, so a single page that runs past the
whole 300s budget would still time out — the heartbeat covers exactly that gap,
and must not leak outside the request it belongs to.
"""

import io
import json
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as sidecar_main  # noqa: E402


def _request(method, params=None, request_id=7):
    return {"id": request_id, "method": method, "params": params or {}}


def _run_main(monkeypatch, requests):
    """Run ``main()`` against in-memory stdio and return (stdout, stderr)."""
    stdin = io.StringIO("".join(json.dumps(request) + "\n" for request in requests))
    stdout = io.StringIO()
    stderr = io.StringIO()
    monkeypatch.setattr(sys, "stdin", stdin)
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    sidecar_main.main()
    return stdout.getvalue(), stderr.getvalue()


def _parse_lines(raw):
    lines = [json.loads(line) for line in raw.splitlines()]
    assert lines, "the sidecar must write at least the ready line"
    return lines


def _heartbeat_indices(lines):
    return [
        index
        for index, line in enumerate(lines)
        if isinstance(line.get("progress"), dict) and line["progress"].get("stage") == "heartbeat"
    ]


def _response_index(lines, request_id=7):
    for index, line in enumerate(lines):
        if line.get("id") == request_id and "progress" not in line:
            return index
    raise AssertionError(f"no response line for request {request_id}: {lines}")


def _live_heartbeat_threads():
    return [thread for thread in threading.enumerate() if thread.name.startswith("diff-heartbeat-")]


@pytest.fixture()
def short_heartbeat(monkeypatch):
    """Shorten the 5s interval so the test does not sleep for seconds."""
    monkeypatch.setattr(sidecar_main, "HEARTBEAT_INTERVAL_SECONDS", 0.01)


def test_a_long_diff_emits_heartbeats_before_the_response(tmp_path, monkeypatch, short_heartbeat):
    def fake_diff(old_path, new_path, options, progress):
        progress({"stage": "start", "oldPages": 1, "newPages": 1})
        # One page that takes much longer than a heartbeat interval and reports
        # nothing in between: the exact situation the heartbeat exists for.
        time.sleep(0.2)
        return {"schemaVersion": 1, "pages": []}

    monkeypatch.setattr(sidecar_main, "diff_files", fake_diff)

    stdout, stderr = _run_main(
        monkeypatch,
        [
            _request(
                "diff_documents",
                {"old_path": str(tmp_path / "old.pdf"), "new_path": str(tmp_path / "new.pdf")},
            )
        ],
    )

    assert stderr == ""
    # Framing: every line is one complete JSON document, newline terminated.
    assert stdout.endswith("\n")
    lines = _parse_lines(stdout)

    assert lines[0] == {"ready": True}
    assert lines[1] == {"id": 7, "progress": {"stage": "start", "oldPages": 1, "newPages": 1}}

    response_index = _response_index(lines)
    heartbeats = _heartbeat_indices(lines)

    assert heartbeats, f"expected at least one heartbeat before the response: {lines}"
    assert max(heartbeats) < response_index
    for index in heartbeats:
        assert lines[index] == {"id": 7, "progress": {"stage": "heartbeat"}}

    # The response is the final line: no heartbeat trails it.
    assert response_index == len(lines) - 1
    assert lines[response_index] == {
        "id": 7,
        "result": {"schemaVersion": 1, "pages": []},
    }

    # And none is written after main() returned either: the thread was joined.
    after_return = stdout
    time.sleep(0.05)
    assert stdout == after_return
    assert _live_heartbeat_threads() == []


def test_a_fast_diff_writes_no_heartbeat(monkeypatch):
    def fake_diff(old_path, new_path, options, progress):
        progress({"stage": "start", "oldPages": 1, "newPages": 1})
        return {"schemaVersion": 1}

    monkeypatch.setattr(sidecar_main, "diff_files", fake_diff)

    stdout, _ = _run_main(
        monkeypatch,
        [_request("diff_documents", {"old_path": "old.pdf", "new_path": "new.pdf"})],
    )

    lines = _parse_lines(stdout)
    assert _heartbeat_indices(lines) == []
    assert _response_index(lines) == len(lines) - 1
    assert _live_heartbeat_threads() == []


def test_non_diff_methods_never_heartbeat(monkeypatch):
    """A slow non-diff request must stay bounded by its own (idle) budget."""

    class SlowSession:
        should_exit = False
        methods = []

        def handle(self, method, params, request_id=0, progress=None):
            SlowSession.methods.append(method)
            time.sleep(0.2)
            return {"id": request_id, "result": {"ok": True}}

    monkeypatch.setattr(sidecar_main, "SidecarSession", SlowSession)
    monkeypatch.setattr(sidecar_main, "HEARTBEAT_INTERVAL_SECONDS", 0.01)

    stdout, _ = _run_main(monkeypatch, [_request("extract_metadata", {}, request_id=3)])

    lines = _parse_lines(stdout)
    assert SlowSession.methods == ["extract_metadata"]
    assert _heartbeat_indices(lines) == []
    # No progress lines at all: the only non-ready line is the response.
    assert lines == [{"ready": True}, {"id": 3, "result": {"ok": True}}]
    assert _live_heartbeat_threads() == []
