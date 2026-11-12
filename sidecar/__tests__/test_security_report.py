"""Security report renderers: deterministic summary, truncation and safe HTML.

The renderers are pure functions over a ``SecurityReport`` dict, so the tests
build contract-shaped reports directly.  The committed
``web-samples/security-sample.pdf`` and its generator are also pinned: the
generator must stay byte-for-byte deterministic, and the sample must keep the
resources the CLI/CI story depends on.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLE = REPO_ROOT / 'web-samples' / 'security-sample.pdf'
GENERATOR = REPO_ROOT / 'scripts' / 'generate-security-sample.py'

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import security_report  # noqa: E402
from security_report import format_security_summary, render_security_html  # noqa: E402


# --- fixtures ---------------------------------------------------------------


def _finding(
    severity: str,
    title: str,
    *,
    category: str = 'security',
    page=None,
) -> dict:
    return {
        'category': category,
        'severity': severity,
        'page': page,
        'title': title,
        'detail': 'detail',
        'evidence': None,
        'recommendation': None,
    }


def _report(findings=(), **overrides) -> dict:
    """A complete, contract-shaped ``SecurityReport`` with empty resources."""
    ordered = list(findings)
    counts = {
        field: sum(1 for item in ordered if item['severity'] == name)
        for field, name in security_report.SEVERITY_FIELDS
    }
    counts['total'] = len(ordered)
    report = {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': '0.2.0'},
        'document': {
            'pages': 1,
            'version': '1.4',
            'encrypted': False,
            'xfa': False,
            'hasMetadata': False,
            'outputIntents': 0,
        },
        'attachments': [],
        'javascript': [],
        'actions': [],
        'signatures': [],
        'encryption': None,
        'findings': ordered,
        'summary': counts,
    }
    report.update(overrides)
    return report


def _attachment(name: str = 'a.txt', **overrides) -> dict:
    entry = {
        'name': name,
        'description': None,
        'size': 5,
        'mimeType': 'text/plain',
        'modified': None,
        'sha256': None,
        'risky': False,
    }
    entry.update(overrides)
    return entry


# --- plain-text summary -----------------------------------------------------


def test_summary_reports_document_facts_resources_and_severities():
    report = _report(
        findings=[_finding('warning', 'Document contains JavaScript')],
        document={
            'pages': 2,
            'version': '1.7',
            'encrypted': False,
            'xfa': True,
            'hasMetadata': True,
            'outputIntents': 1,
        },
        attachments=[_attachment()],
        javascript=[
            {
                'name': 'init',
                'location': 'Names',
                'page': None,
                'source': 'app.alert(1)',
                'truncated': False,
            }
        ],
        actions=[
            {
                'location': 'OpenAction',
                'page': None,
                'subtype': 'JavaScript',
                'target': None,
                'risky': True,
            },
            {
                'location': 'Annotation 1',
                'page': 1,
                'subtype': 'URI',
                'target': 'https://example.com/x',
                'risky': False,
            },
        ],
        signatures=[
            {
                'fieldName': 'Approval',
                'page': 1,
                'signer': 'Alice',
                'signedAt': None,
                'reason': None,
                'location': None,
                'subFilter': 'adbe.pkcs7.detached',
                'byteRangeValid': True,
                'verified': False,
            }
        ],
        encryption={
            'filter': 'Standard',
            'version': 2,
            'revision': 3,
            'keyLength': 128,
            'permissions': {'raw': -4, 'print': True, 'modify': False},
        },
    )

    text = format_security_summary(report, 'sample.pdf')

    assert text.startswith('pdf-inspector 0.2.0 - PDF security\n')
    assert 'file: sample.pdf\n' in text
    assert (
        'document: 2 page(s), version 1.7, encrypted: no, XFA: yes, '
        'metadata: yes, output intents: 1' in text
    )
    assert 'resources: 1 attachment, 1 JavaScript, 2 actions, 1 signature field' in text
    assert 'encryption: filter Standard, V 2, R 3, 128-bit key' in text
    assert 'permissions: print=allowed, modify=denied' in text
    assert 'summary: 0 errors, 1 warnings, 0 info (1 total)' in text
    assert '  1. [warning] security: Document contains JavaScript' in text


def test_summary_reports_empty_resources_and_no_findings():
    text = format_security_summary(_report())

    assert 'resources: 0 attachments, 0 JavaScript, 0 actions, 0 signature fields' in text
    assert 'encryption: none' in text
    assert security_report.NO_FINDINGS_TEXT in text


def test_summary_never_embeds_an_absolute_path():
    report = _report(findings=[_finding('info', 'Document contains embedded files')])

    posix = format_security_summary(report, '/tmp/secret/report.pdf')
    windows = format_security_summary(report, r'C:\Users\me\secret\report.pdf')

    assert 'file: report.pdf' in posix
    assert '/tmp/secret' not in posix
    assert 'file: report.pdf' in windows
    assert 'C:\\Users' not in windows
    assert 'secret' not in posix and 'secret' not in windows


def test_summary_orders_findings_severity_first_and_truncates():
    findings = [_finding('info', f'Info {index:02d}') for index in range(1, 23)]
    findings += [_finding('warning', f'Warn {index}') for index in range(1, 4)]
    findings += [_finding('error', f'Error {index}') for index in range(1, 3)]
    report = _report(findings)

    text = format_security_summary(report)
    severities = re.findall(r'^\s+\d+\. \[([a-z]+)\]', text, re.MULTILINE)

    assert severities == ['error'] * 2 + ['warning'] * 3 + ['info'] * 15
    assert 'findings: 27 total, showing 20' in text
    assert '... 7 more finding(s)' in text
    assert 'Info 16' not in text


def test_summary_honours_a_custom_finding_limit():
    findings = [_finding('info', f'Info {index:02d}') for index in range(1, 6)]

    text = format_security_summary(_report(findings), max_findings=2)

    assert 'findings: 5 total, showing 2' in text
    assert '... 3 more finding(s)' in text


def test_summary_is_deterministic_and_strips_control_characters():
    report = _report(
        findings=[_finding('warning', 'bad \x1b[31mred\nsecond line')],
        attachments=[_attachment('a.txt')],
    )

    first = format_security_summary(report, 'sample.pdf')
    second = format_security_summary(report, 'sample.pdf')

    assert first == second
    assert '\x1b' not in first
    assert 'bad [31mred second line' in first


# --- HTML report ------------------------------------------------------------


def test_html_is_standalone_and_has_no_active_content():
    report = _report(
        findings=[_finding('warning', 'Document contains JavaScript')],
        attachments=[_attachment()],
        encryption={
            'filter': 'Standard',
            'version': 2,
            'revision': 3,
            'keyLength': 128,
            'permissions': {
                'raw': -4,
                'print': True,
                'modify': False,
                'copy': None,
                'annotate': False,
                'fillForms': False,
                'accessibility': None,
                'assemble': False,
                'highQualityPrint': False,
            },
        },
    )

    html = render_security_html(report)

    assert html.startswith('<!DOCTYPE html>')
    assert '<style>' in html
    assert '<script' not in html
    assert '<link' not in html
    assert 'src=' not in html
    assert '@import' not in html
    assert '<title>PDF security report - pdf-inspector 0.2.0</title>' in html
    for section in (
        '<h2>Document</h2>',
        '<h2>Summary</h2>',
        '<h2>Attachments</h2>',
        '<h2>JavaScript</h2>',
        '<h2>Actions</h2>',
        '<h2>Signatures</h2>',
        '<h2>Encryption and permissions</h2>',
        '<h2>Security findings</h2>',
    ):
        assert section in html


def test_html_escapes_every_user_controlled_value():
    report = _report(
        findings=[_finding('warning', '<script>alert("title")</script>')],
        attachments=[
            _attachment(
                name='<script>alert(1)</script>',
                description='"><img src=x>',
            )
        ],
        javascript=[
            {
                'name': '</pre><script>alert(2)</script>',
                'location': 'OpenAction',
                'page': None,
                'source': '</pre><script>alert(3)</script>',
                'truncated': False,
            }
        ],
        actions=[
            {
                'location': 'Annotation 1',
                'page': 1,
                'subtype': 'URI',
                'target': '"><svg onload=alert(4)>',
                'risky': False,
            }
        ],
        signatures=[
            {
                'fieldName': '<b>field</b>',
                'page': 1,
                'signer': '<i>signer</i>',
                'signedAt': None,
                'reason': None,
                'location': None,
                'subFilter': '<em>filter</em>',
                'byteRangeValid': None,
                'verified': False,
            }
        ],
    )

    html = render_security_html(report)

    assert '<script' not in html
    assert '<img' not in html
    assert '<svg' not in html
    assert '<b>' not in html
    assert '<i>' not in html
    assert '<em>' not in html
    assert '&lt;script&gt;alert(1)&lt;/script&gt;' in html
    assert '&lt;img src=x&gt;' in html
    assert '&lt;svg onload=alert(4)&gt;' in html


def test_html_marks_truncated_scripts_and_unverified_signatures():
    report = _report(
        javascript=[
            {
                'name': 'huge',
                'location': 'Names',
                'page': None,
                'source': 'x' * 4096,
                'truncated': True,
            }
        ],
        signatures=[
            {
                'fieldName': 'Approval',
                'page': 1,
                'signer': 'Alice',
                'signedAt': 'D:20240101000000Z',
                'reason': None,
                'location': None,
                'subFilter': 'adbe.pkcs7.detached',
                'byteRangeValid': True,
                'verified': False,
            }
        ],
    )

    html = render_security_html(report)

    assert '>truncated</span>' in html
    assert '>not verified</span>' in html
    assert 'valid structure' in html
    assert 'Preview only' in html


def test_html_empty_resources_show_empty_states():
    html = render_security_html(_report())

    assert 'No embedded files.' in html
    assert 'No JavaScript actions.' in html
    assert 'No actions.' in html
    assert 'No signature fields.' in html
    assert 'Not encrypted.' in html
    assert 'No security findings.' in html


def test_html_renders_allowed_denied_and_unknown_permissions():
    report = _report(
        encryption={
            'filter': 'Standard',
            'version': 2,
            'revision': 3,
            'keyLength': 128,
            'permissions': {
                'raw': -4,
                'print': True,
                'modify': False,
                'copy': None,
                'annotate': False,
                'fillForms': False,
                'accessibility': None,
                'assemble': False,
                'highQualityPrint': False,
            },
        }
    )

    html = render_security_html(report)

    assert 'badge-allowed' in html and '>allowed</span>' in html
    assert 'badge-denied' in html and '>denied</span>' in html
    assert 'badge-unknown' in html and '>unknown</span>' in html
    assert 'best-effort' in html


def test_html_has_no_absolute_paths_or_timestamps():
    report = _report(findings=[_finding('info', 'Document has a signature field')])

    html = render_security_html(report, '/home/user/private/report.pdf')

    assert 'file report.pdf' in html
    assert '/home/user' not in html
    assert 'private' not in html
    assert not re.search(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', html)


def test_html_is_deterministic():
    report = _report(
        findings=[_finding('warning', 'Document contains JavaScript')],
        attachments=[_attachment()],
    )

    assert render_security_html(report, 'sample.pdf') == render_security_html(
        report, 'sample.pdf'
    )


def test_prioritize_findings_is_stable_inside_a_severity():
    findings = [
        _finding('info', 'b'),
        _finding('warning', 'c'),
        _finding('info', 'a'),
        _finding('error', 'd'),
    ]

    ordered = security_report.prioritize_findings(findings)

    assert [item['title'] for item in ordered] == ['d', 'c', 'b', 'a']


# --- deterministic sample ---------------------------------------------------


def _require_sample() -> None:
    if not SAMPLE.exists():
        pytest.skip(
            'web-samples/security-sample.pdf is not present; run '
            'scripts/generate-security-sample.py (the security CI job does this)'
        )


def test_generator_is_deterministic_and_matches_the_committed_sample(tmp_path):
    _require_sample()
    target = tmp_path / 'security-sample.pdf'

    result = subprocess.run(
        [sys.executable, str(GENERATOR), str(target)],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )

    assert result.returncode == 0, result.stderr
    assert target.read_bytes() == SAMPLE.read_bytes()


def test_committed_sample_is_readable_and_contains_the_expected_resources():
    _require_sample()
    import pdfplumber

    from audit import security_report
    from extractor import PdfExtractor

    with pdfplumber.open(str(SAMPLE)) as pdf:
        assert len(pdf.pages) == 1
        assert 'PDF Inspector security sample' in (pdf.pages[0].extract_text() or '')

    extractor = PdfExtractor(str(SAMPLE))
    try:
        report = security_report(extractor)
    finally:
        extractor.close()

    assert report['document']['pages'] == 1
    assert report['document']['xfa'] is True
    assert report['encryption'] is None

    attachments = {item['name']: item for item in report['attachments']}
    assert 'notes.txt' in attachments
    notes = attachments['notes.txt']
    assert notes['size'] == len(b'PDF Inspector security sample attachment.\n')
    assert notes['mimeType'] == 'text/plain'
    assert re.fullmatch(r'[0-9a-f]{64}', notes['sha256'])

    assert len(report['javascript']) == 2
    subtypes = {action['subtype'] for action in report['actions']}
    assert {'JavaScript', 'URI'} <= subtypes
    uri = [action for action in report['actions'] if action['subtype'] == 'URI']
    assert uri and uri[0]['target'].startswith('https://example.com/')

    signature = report['signatures'][0]
    assert signature['fieldName'] == 'Approval'
    assert signature['verified'] is False
    assert signature['byteRangeValid'] is True

    assert report['summary']['warnings'] >= 2
    titles = [finding['title'] for finding in report['findings']]
    assert 'Document contains JavaScript' in titles
    assert 'Document contains an XFA form' in titles
    assert 'Document contains embedded files' in titles
