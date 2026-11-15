"""RPC report rendering: render an audit/diff payload the renderer already holds.

The two ``render_*_report_html`` methods only format a report the renderer sent
back to the sidecar, so they must not open a document, use the page cache or
change any session state — and an invalid payload must come back as one readable
error message instead of a traceback.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from audit_report import render_audit_html  # noqa: E402
from cache import PageCache  # noqa: E402
from main import RpcError, SidecarSession, _handle_request  # noqa: E402
from report import render_html  # noqa: E402


# --- fixture builders -------------------------------------------------------


def _finding(
    *,
    category: str = 'metadata',
    severity: str = 'info',
    page=None,
    title: str = 'Missing document title',
) -> dict:
    return {
        'category': category,
        'severity': severity,
        'page': page,
        'title': title,
        'detail': 'The document information dictionary has no Title.',
        'evidence': None,
        'recommendation': None,
    }


def _audit_report(findings=None, *, version='0.4.0') -> dict:
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': version},
        'document': {
            'pages': 1,
            'version': '1.4',
            'encrypted': False,
            'title': 'Quarterly report',
            'author': 'Example Author',
            'producer': 'ReportLab',
            'language': 'en-US',
            'tagged': True,
        },
        'findings': [_finding()] if findings is None else list(findings),
    }


BASELINE_STATUSES = ('new', 'existing', 'moved', 'escalated', 'fixed', 'waived')


def _baseline_entry(status: str, *, current=None, baseline=None) -> dict:
    return {
        'status': status,
        'fingerprint': '0' * 32,
        'current': current,
        'baseline': baseline,
    }


def _baseline_comparison(entries) -> dict:
    counts = {status: 0 for status in BASELINE_STATUSES}
    for entry in entries:
        counts[entry['status']] += 1
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': '0.4.0'},
        'current': {
            'pages': 1,
            'findings': sum(1 for entry in entries if entry['current'] is not None),
        },
        'baseline': {
            'pages': 1,
            'findings': sum(1 for entry in entries if entry['baseline'] is not None),
        },
        'summary': counts,
        'findings': list(entries),
    }


def _diff_result(changes=None) -> dict:
    changes = [
        {
            'kind': 'modified',
            'type': 'word',
            'oldPage': 1,
            'newPage': 1,
            'oldBBox': {'x0': 100.0, 'y0': 697.5, 'x1': 140.0, 'y1': 709.5},
            'newBBox': {'x0': 100.0, 'y0': 697.5, 'x1': 150.0, 'y1': 709.5},
            'textOld': 'Old',
            'textNew': 'New',
            'details': {},
        }
    ] if changes is None else list(changes)
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': '0.4.0'},
        'options': {
            'positionTolerance': 1.0,
            'textTolerance': 'normalized',
            'ignoreTypes': [],
            'ignoreFonts': False,
            'ignoreColors': False,
            'ignoreImages': False,
            'ignoreRegions': [],
        },
        'old': {'pages': 1, 'sha256': 'a' * 64},
        'new': {'pages': 1, 'sha256': 'b' * 64},
        'summary': {
            'pagesAdded': 0,
            'pagesRemoved': 0,
            'pagesChanged': 1,
            'pagesReordered': 0,
            'objectsAdded': 0,
            'objectsRemoved': 0,
            'objectsMoved': 0,
            'objectsModified': len(changes),
        },
        'pages': [
            {
                'oldIndex': 1,
                'newIndex': 1,
                'status': 'changed',
                'oldSize': {'width': 612.0, 'height': 792.0},
                'newSize': {'width': 612.0, 'height': 792.0},
                'match': {'score': 0.75, 'reordered': False},
                'changes': changes,
            }
        ],
    }


def _session_without_document() -> SidecarSession:
    """A session whose extractor factory fails if anything tries to open a PDF."""

    def factory(path, password=None):  # pragma: no cover - must never run
        raise AssertionError(f'render methods must not open a document: {path}')

    return SidecarSession(extractor_factory=factory)


# --- audit report -----------------------------------------------------------


def test_render_audit_report_html_matches_the_renderer():
    session = _session_without_document()
    report = _audit_report()

    response = session._dispatch('render_audit_report_html', {'report': report})

    assert response == {'html': render_audit_html(report)}
    assert response['html'].startswith('<!DOCTYPE html>')
    assert 'PDF audit report' in response['html']
    assert '<section id="baseline">' not in response['html']


def test_render_audit_report_html_treats_a_missing_baseline_as_none():
    session = _session_without_document()
    report = _audit_report()

    omitted = session._dispatch('render_audit_report_html', {'report': report})
    explicit_null = session._dispatch(
        'render_audit_report_html', {'report': report, 'baseline': None}
    )

    assert omitted == explicit_null == {'html': render_audit_html(report)}


def test_render_audit_report_html_renders_baseline_counts():
    session = _session_without_document()
    report = _audit_report()
    baseline = _baseline_comparison(
        [
            _baseline_entry('new', current=_finding(severity='warning')),
            _baseline_entry('existing', current=_finding(), baseline=_finding()),
            _baseline_entry('fixed', baseline=_finding(title='Unembedded font')),
        ]
    )

    response = session._dispatch(
        'render_audit_report_html', {'report': report, 'baseline': baseline}
    )

    assert response == {'html': render_audit_html(report, baseline=baseline)}
    html_text = response['html']
    assert '<section id="baseline">' in html_text
    assert '<th scope="row">New</th><td>1</td>' in html_text
    assert '<th scope="row">Existing</th><td>1</td>' in html_text
    assert '<th scope="row">Fixed</th><td>1</td>' in html_text
    assert '<th scope="row">Escalated</th><td>0</td>' in html_text


def test_render_audit_report_html_is_deterministic():
    session = _session_without_document()
    report = _audit_report()
    baseline = _baseline_comparison([_baseline_entry('new', current=_finding())])
    params = {'report': report, 'baseline': baseline}

    first = session._dispatch('render_audit_report_html', params)
    second = _session_without_document()._dispatch('render_audit_report_html', params)

    assert first == second
    # Rendering must not have mutated the payload the renderer sent.
    assert params == {'report': report, 'baseline': baseline}


# --- diff report ------------------------------------------------------------


def test_render_diff_report_html_matches_the_renderer():
    session = _session_without_document()
    result = _diff_result()

    response = session._dispatch('render_diff_report_html', {'result': result})

    assert response == {'html': render_html(result)}
    assert response['html'].startswith('<!DOCTYPE html>')
    assert 'PDF diff report' in response['html']
    assert 'New' in response['html']


def test_render_diff_report_html_is_deterministic():
    session = _session_without_document()
    result = _diff_result()

    first = session._dispatch('render_diff_report_html', {'result': result})
    second = _session_without_document()._dispatch('render_diff_report_html', {'result': result})

    assert first == second
    assert result == _diff_result()


# --- read-only behaviour ----------------------------------------------------


def test_render_methods_need_no_open_document():
    session = _session_without_document()
    assert session.extractor is None

    assert 'error' not in session.handle(
        'render_audit_report_html', {'report': _audit_report()}, request_id=1
    )
    assert 'error' not in session.handle(
        'render_diff_report_html', {'result': _diff_result()}, request_id=2
    )
    assert session.extractor is None
    assert session.should_exit is False


def test_render_methods_leave_the_page_cache_and_document_alone(monkeypatch):
    cache = PageCache(max_pages=10)
    cache.put(1, {'words': [{'text': 'cached'}]})
    touched = []
    for name in ('get', 'put', 'clear'):
        original = getattr(cache, name)

        def spy(*args, _name=name, _original=original, **kwargs):
            touched.append(_name)
            return _original(*args, **kwargs)

        monkeypatch.setattr(cache, name, spy)

    session = SidecarSession(cache=cache)
    session.handle('render_audit_report_html', {'report': _audit_report()}, request_id=1)
    session.handle('render_diff_report_html', {'result': _diff_result()}, request_id=2)

    assert touched == []
    assert session.cache.get(1) == {'words': [{'text': 'cached'}]}
    assert session.extractor is None


def test_render_methods_keep_the_open_document():
    class FakeExtractor:
        def __init__(self, path, password=None):
            self.path = path
            self.closes = 0

        def close(self):
            self.closes += 1

    session = SidecarSession(extractor_factory=FakeExtractor)
    session.handle('open', {'path': 'a.pdf'}, request_id=1)
    extractor = session.extractor

    session.handle('render_audit_report_html', {'report': _audit_report()}, request_id=2)
    session.handle('render_diff_report_html', {'result': _diff_result()}, request_id=3)

    assert session.extractor is extractor
    assert extractor.closes == 0


def test_render_audit_report_html_is_reachable_through_handle_request():
    """The transport wrapper passes rendering through without a heartbeat."""
    progress = []
    response = _handle_request(
        _session_without_document(),
        'render_audit_report_html',
        {'report': _audit_report()},
        4,
        progress.append,
    )

    assert response == {'id': 4, 'result': {'html': render_audit_html(_audit_report())}}
    assert progress == []


# --- invalid payloads -------------------------------------------------------


@pytest.mark.parametrize(
    'params, message',
    [
        ({}, '"report" must be a JSON object'),
        ({'report': None}, '"report" must be a JSON object'),
        ({'report': 'report'}, '"report" must be a JSON object'),
        ({'report': [1, 2]}, '"report" must be a JSON object'),
        ({'report': {}, 'baseline': 'baseline'}, '"baseline" must be a JSON object or null'),
        ({'report': {}, 'baseline': 7}, '"baseline" must be a JSON object or null'),
        ({'report': {}, 'baseline': [1]}, '"baseline" must be a JSON object or null'),
    ],
)
def test_render_audit_report_html_rejects_invalid_payloads(params, message):
    session = _session_without_document()

    response = session.handle('render_audit_report_html', params, request_id=9)

    assert response == {'id': 9, 'error': message}
    with pytest.raises(RpcError) as excinfo:
        session._dispatch('render_audit_report_html', params)
    assert str(excinfo.value) == message


@pytest.mark.parametrize(
    'params, message',
    [
        ({}, '"result" must be a JSON object'),
        ({'result': None}, '"result" must be a JSON object'),
        ({'result': 'result'}, '"result" must be a JSON object'),
        ({'result': []}, '"result" must be a JSON object'),
    ],
)
def test_render_diff_report_html_rejects_invalid_payloads(params, message):
    session = _session_without_document()

    response = session.handle('render_diff_report_html', params, request_id=9)

    assert response == {'id': 9, 'error': message}


def test_render_methods_reject_non_object_params():
    session = _session_without_document()

    for method in ('render_audit_report_html', 'render_diff_report_html'):
        assert session.handle(method, ['report'], request_id=3) == {
            'id': 3,
            'error': '"params" must be an object',
        }


def test_malformed_payload_is_one_readable_error_not_a_traceback(capsys):
    """A payload with the wrong field types must not leak a traceback to the parent."""
    session = _session_without_document()

    response = session.handle(
        'render_diff_report_html', {'result': {'summary': 'not-an-object'}}, request_id=5
    )

    assert response['id'] == 5
    assert set(response) == {'id', 'error'}
    assert response['error'].startswith('Cannot render diff report: ')
    assert 'Traceback' not in response['error']
    assert capsys.readouterr().err == ''


def test_malformed_audit_report_is_one_readable_error(capsys):
    session = _session_without_document()

    response = session.handle(
        'render_audit_report_html', {'report': {'tool': 'not-an-object'}}, request_id=6
    )

    assert response['id'] == 6
    assert set(response) == {'id', 'error'}
    assert response['error'].startswith('Cannot render audit report: ')
    assert capsys.readouterr().err == ''
