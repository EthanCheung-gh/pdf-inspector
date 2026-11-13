"""``pdf-inspector audit`` CLI: formats, exit codes, validation and safety."""

from __future__ import annotations

import io
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI = REPO_ROOT / 'sidecar' / 'cli.py'

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cli  # noqa: E402
from audit import finding_fingerprint  # noqa: E402

REPORT_KEYS = {'schemaVersion', 'tool', 'document', 'summary', 'findings'}
TOOL_KEYS = {'name', 'version'}
DOCUMENT_KEYS = {
    'pages',
    'version',
    'encrypted',
    'title',
    'author',
    'producer',
    'language',
    'tagged',
}
SUMMARY_KEYS = {'total', 'errors', 'warnings', 'info'}
FINDING_KEYS = {
    'category',
    'severity',
    'page',
    'title',
    'detail',
    'evidence',
    'recommendation',
    'fingerprint',
}


# --- fixtures ---------------------------------------------------------------


def _png(size: int) -> ImageReader:
    buffer = io.BytesIO()
    Image.new('RGB', (size, size), (180, 40, 40)).save(buffer, format='PNG')
    buffer.seek(0)
    return ImageReader(buffer)


def _text_pdf(path: Path) -> str:
    """A clean, text-only reportlab PDF: no audit warnings, only info findings."""
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.setFont('Helvetica', 12)
    canvas.drawString(72, 720, 'Hello audit')
    canvas.showPage()
    canvas.save()
    return str(path)


def _findings_pdf(path: Path) -> str:
    """An image-only page drawn at ~2.88 dpi: two warnings plus info findings."""
    canvas = rl_canvas.Canvas(str(path), pagesize=letter)
    canvas.drawImage(_png(8), 72, 400, width=200, height=200)
    canvas.showPage()
    canvas.save()
    return str(path)


@pytest.fixture(scope='module')
def docs(tmp_path_factory):
    root = tmp_path_factory.mktemp('audit-cli-docs')

    not_pdf = root / 'not_pdf.txt'
    not_pdf.write_bytes(b'this is plain text, not a pdf\n')
    broken = root / 'broken.pdf'
    broken.write_bytes(b'%PDF-1.4\nthis is not a real pdf body\n')

    return {
        'text': _text_pdf(root / 'text.pdf'),
        'findings': _findings_pdf(root / 'findings.pdf'),
        'not_pdf': str(not_pdf),
        'broken': str(broken),
        'root': str(root),
    }


def run_cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def run_audit(docs, key: str, *args: str) -> subprocess.CompletedProcess:
    return run_cli('audit', docs[key], *args)


def audit_json(docs, key: str = 'findings') -> dict:
    result = run_audit(docs, key, '--format', 'json')
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _report(findings, *, errors=0, warnings=0, info=0) -> dict:
    """Hand-written contract-shaped report for threshold tests."""
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': '0.2.0'},
        'document': {
            'pages': 1,
            'version': '1.4',
            'encrypted': False,
            'title': None,
            'author': None,
            'producer': None,
            'language': None,
            'tagged': False,
        },
        'summary': {
            'total': errors + warnings + info,
            'errors': errors,
            'warnings': warnings,
            'info': info,
        },
        'findings': list(findings),
    }


def _finding(severity: str, title: str = 'Finding', *, page=None) -> dict:
    return {
        'category': 'fonts',
        'severity': severity,
        'page': page,
        'title': title,
        'detail': 'detail',
        'evidence': None,
        'recommendation': None,
    }


def _extraction_failure(page: int) -> dict:
    """Mirror the engine's page-extraction finding, the only ``error`` source.

    ``audit.audit_file`` emits it for a page that cannot be extracted; the
    synthetic report lets the CLI exercise ``--fail-on error`` without depending
    on how a damaged page happens to fail in the current engine.
    """
    return {
        'category': 'pages',
        'severity': 'error',
        'page': page,
        'title': f'Page {page} could not be analysed',
        'detail': (
            f'Extracting page {page} failed: broken content stream. '
            'The rest of the batch was still audited.'
        ),
        'evidence': 'exception=RuntimeError',
        'recommendation': 'Check the page content stream; the page may be damaged.',
    }


# --- JSON output ------------------------------------------------------------


def test_json_matches_the_audit_report_contract(docs):
    data = audit_json(docs)

    assert set(data) == REPORT_KEYS
    assert data['schemaVersion'] == 1
    assert set(data['tool']) == TOOL_KEYS
    assert data['tool']['name'] == 'pdf-inspector'
    assert re.fullmatch(r'\d+\.\d+\.\d+', data['tool']['version'])
    assert set(data['document']) == DOCUMENT_KEYS
    assert set(data['summary']) == SUMMARY_KEYS
    assert data['document']['pages'] == 1

    assert data['summary']['total'] == len(data['findings'])
    assert data['summary']['warnings'] == 2
    assert data['summary']['errors'] == 0
    for finding in data['findings']:
        assert set(finding) == FINDING_KEYS
        assert finding['severity'] in ('error', 'warning', 'info')
        assert finding['category'] in (
            'fonts',
            'pages',
            'images',
            'metadata',
            'structure',
            'security',
        )
        assert finding['page'] is None or finding['page'] >= 1
        assert re.fullmatch(r'[0-9a-f]{32}', finding['fingerprint'])


def test_json_stdout_is_pure_json(docs):
    result = run_audit(docs, 'findings', '--format', 'json')

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.lstrip().startswith('{')
    json.loads(result.stdout)


def test_json_is_deterministic_across_runs(docs):
    first = run_audit(docs, 'findings', '--format', 'json')
    second = run_audit(docs, 'findings', '--format', 'json')

    assert first.returncode == second.returncode == 0
    assert first.stdout == second.stdout


def test_json_has_no_absolute_paths_or_timestamps(docs):
    result = run_audit(docs, 'findings', '--format', 'json')

    assert docs['root'] not in result.stdout
    assert docs['findings'] not in result.stdout
    assert not re.search(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', result.stdout)
    assert '.pdf' not in json.dumps(json.loads(result.stdout))


def test_json_output_file_equals_the_stdout_payload(docs, tmp_path):
    output = tmp_path / 'audit.json'
    result = run_audit(docs, 'findings', '--format', 'json', '--output', str(output))

    assert result.returncode == 0
    assert result.stderr == ''
    assert not result.stdout.lstrip().startswith('{')
    assert 'summary:' in result.stdout

    written = json.loads(output.read_text(encoding='utf-8'))
    assert written == audit_json(docs)


# --- summary output ---------------------------------------------------------


def test_summary_is_the_default(docs):
    result = run_audit(docs, 'findings')

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.startswith('pdf-inspector ')
    assert ' - PDF audit' in result.stdout
    assert 'document: 1 page(s)' in result.stdout
    assert 'summary: 0 errors, 2 warnings, 2 info (4 total)' in result.stdout


def test_summary_lists_findings_with_severity_page_and_title(docs):
    result = run_audit(docs, 'findings')

    assert '[warning] images, page 1: Page 1 has images but no extractable text' in result.stdout
    assert '[info] metadata: Missing document language' in result.stdout
    assert 'Traceback' not in result.stderr


def test_summary_reports_the_source_file(docs):
    result = run_audit(docs, 'text')

    assert f'file: {docs["text"]}' in result.stdout
    assert result.returncode == 0


def test_quiet_suppresses_the_human_summary_only(docs):
    quiet_summary = run_audit(docs, 'findings', '--quiet')
    assert quiet_summary.returncode == 0
    assert quiet_summary.stdout == ''
    assert quiet_summary.stderr == ''

    quiet_json = run_audit(docs, 'findings', '--format', 'json', '--quiet')
    assert quiet_json.returncode == 0
    assert json.loads(quiet_json.stdout)['summary']['warnings'] == 2


def test_quiet_with_output_writes_file_without_stdout(docs, tmp_path):
    output = tmp_path / 'audit.html'
    result = run_audit(
        docs,
        'findings',
        '--format',
        'html',
        '--output',
        str(output),
        '--quiet',
    )

    assert result.returncode == 0
    assert result.stdout == ''
    assert output.read_text(encoding='utf-8').startswith('<!DOCTYPE html>')


# --- HTML output ------------------------------------------------------------


def test_html_on_stdout_is_standalone(docs):
    result = run_audit(docs, 'findings', '--format', 'html')

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.startswith('<!DOCTYPE html>')
    assert '<title>PDF audit report' in result.stdout
    assert '<style>' in result.stdout
    assert '<script' not in result.stdout
    # The human summary is never mixed into the machine payload.
    assert 'summary: 0 errors' not in result.stdout


def test_html_output_file_is_standalone_and_uses_lf(docs, tmp_path):
    output = tmp_path / 'audit.html'
    result = run_audit(docs, 'findings', '--format', 'html', '--output', str(output))

    assert result.returncode == 0
    assert 'summary: 0 errors, 2 warnings' in result.stdout

    raw = output.read_bytes()
    assert raw.startswith(b'<!DOCTYPE html>')
    assert b'\r\n' not in raw
    content = raw.decode('utf-8')
    assert '<title>PDF audit report' in content
    assert 'Findings by severity' in content
    assert 'Page 1 has images but no extractable text' in content


def test_html_escapes_pdf_metadata(docs, tmp_path):
    output = tmp_path / 'audit.html'
    result = run_audit(docs, 'text', '--format', 'html', '--output', str(output))

    assert result.returncode == 0
    content = output.read_text(encoding='utf-8')
    # Metadata such as the reportlab producer must be text, never markup.
    assert '<script' not in content
    assert 'ReportLab' in content
    assert 'http://' not in content and 'https://' not in content


# --- --fail-on exit codes ---------------------------------------------------


@pytest.mark.parametrize(
    'key, fail_on, expected',
    [
        ('text', 'none', 0),
        ('text', 'error', 0),
        ('text', 'warning', 0),
        ('findings', 'none', 0),
        ('findings', 'error', 0),
        ('findings', 'warning', 1),
    ],
)
def test_fail_on_thresholds(docs, key, fail_on, expected):
    result = run_audit(docs, key, '--fail-on', fail_on, '--quiet')

    assert result.returncode == expected, result.stderr
    if expected:
        assert 'fail-on warning' in result.stderr
        assert '2 warning(s)' in result.stderr
    else:
        assert result.stderr == ''


def test_fail_on_still_prints_the_summary(docs):
    result = run_audit(docs, 'findings', '--fail-on', 'warning')

    assert result.returncode == 1
    assert 'summary: 0 errors, 2 warnings' in result.stdout
    assert 'pdf-inspector: ' in result.stderr


def test_fail_on_writes_the_report_before_failing(docs, tmp_path):
    output = tmp_path / 'audit.json'
    result = run_audit(
        docs, 'findings', '--format', 'json', '--output', str(output), '--fail-on', 'warning'
    )

    assert result.returncode == 1
    assert json.loads(output.read_text(encoding='utf-8'))['summary']['warnings'] == 2


def test_error_findings_trip_fail_on_error(monkeypatch, capsys, docs):
    report = _report([_extraction_failure(2)], errors=1)

    monkeypatch.setattr(cli, 'audit_file', lambda path: report)
    code = cli.main(['audit', docs['text'], '--fail-on', 'error', '--quiet'])

    captured = capsys.readouterr()
    assert code == 1
    assert captured.out == ''
    assert '1 audit error(s) found (fail-on error)' in captured.err


def test_fail_on_error_writes_the_payload_and_exits_one(monkeypatch, capsys, docs, tmp_path):
    output = tmp_path / 'audit.json'
    report = _report([_extraction_failure(3)], errors=1)

    monkeypatch.setattr(cli, 'audit_file', lambda path: report)
    code = cli.main(
        [
            'audit',
            docs['text'],
            '--format',
            'json',
            '--output',
            str(output),
            '--fail-on',
            'error',
            '--quiet',
        ]
    )

    assert code == 1
    assert capsys.readouterr().out == ''
    written = json.loads(output.read_text(encoding='utf-8'))
    assert written == report
    assert written['summary']['errors'] == 1


def test_summary_shows_errors_and_warnings_before_late_info_findings(
    monkeypatch, capsys, docs
):
    findings = [
        _finding('info', f'Info {index:02d}', page=index) for index in range(1, 23)
    ]
    findings += [_extraction_failure(page) for page in (1, 2, 3)]
    report = _report(findings, errors=3, info=22)

    monkeypatch.setattr(cli, 'audit_file', lambda path: report)
    code = cli.main(['audit', docs['text']])

    out = capsys.readouterr().out
    assert code == 0
    severities = re.findall(r'^\s+\d+\. \[(\w+)\]', out, re.MULTILINE)
    assert severities == ['error'] * 3 + ['info'] * 17
    assert 'Info 18' not in out
    assert '... 5 more finding(s)' in out


def test_error_findings_trip_fail_on_warning(monkeypatch, capsys, docs):
    report = _report(
        [_extraction_failure(1), _finding('warning', 'Font not embedded: X')],
        errors=1,
        warnings=1,
    )

    monkeypatch.setattr(cli, 'audit_file', lambda path: report)
    code = cli.main(['audit', docs['text'], '--fail-on', 'warning', '--quiet'])

    assert code == 1
    assert '1 audit error(s) and 1 warning(s) found (fail-on warning)' in capsys.readouterr().err


def test_warnings_do_not_trip_fail_on_error(monkeypatch, docs):
    report = _report([_finding('warning')], warnings=1)

    monkeypatch.setattr(cli, 'audit_file', lambda path: report)

    assert cli.main(['audit', docs['text'], '--fail-on', 'error', '--quiet']) == 0


def test_audit_failure_reason_helper():
    clean = _report([])
    warned = _report([_finding('warning')], warnings=1)
    failed = _report([_extraction_failure(1)], errors=1)

    assert cli.audit_failure_reason(clean, 'none') is None
    assert cli.audit_failure_reason(clean, 'error') is None
    assert cli.audit_failure_reason(clean, 'warning') is None

    assert cli.audit_failure_reason(warned, 'none') is None
    assert cli.audit_failure_reason(warned, 'error') is None
    assert 'fail-on warning' in cli.audit_failure_reason(warned, 'warning')

    assert 'fail-on error' in cli.audit_failure_reason(failed, 'error')
    assert 'fail-on warning' in cli.audit_failure_reason(failed, 'warning')

    with pytest.raises(ValueError):
        cli.audit_failure_reason(clean, 'sometimes')


def _comparison(*entries) -> dict:
    """A minimal BaselineComparison: ``(status, severity)`` per current finding."""
    statuses = ('new', 'existing', 'moved', 'escalated', 'fixed', 'waived')
    counts = {status: 0 for status in statuses}
    for status, _severity in entries:
        counts[status] += 1
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': '0.3.3'},
        'current': {'pages': 1, 'findings': len(entries)},
        'baseline': {'pages': 1, 'findings': 0},
        'summary': counts,
        'findings': [
            {
                'status': status,
                'fingerprint': '0' * 32,
                'current': None if status == 'fixed' else _finding(severity, status),
                'baseline': None,
            }
            for status, severity in entries
        ],
    }


def test_audit_failure_reason_with_a_comparison_only_counts_new_and_escalated():
    report = _report([_finding('warning'), _finding('warning', 'X')], warnings=2)

    history = _comparison(('existing', 'warning'), ('moved', 'error'))
    assert cli.audit_failure_reason(report, 'warning', history) is None
    assert cli.audit_failure_reason(report, 'error', history) is None

    new = _comparison(('existing', 'warning'), ('new', 'warning'))
    reason = cli.audit_failure_reason(report, 'warning', new)
    assert '1 new or escalated warning(s)' in reason
    assert cli.audit_failure_reason(report, 'error', new) is None

    escalated = _comparison(('escalated', 'error'))
    assert '1 new or escalated audit error(s)' in cli.audit_failure_reason(
        report, 'error', escalated
    )
    assert 'fail-on warning' in cli.audit_failure_reason(report, 'warning', escalated)

    fixed = _comparison(('fixed', 'error'))
    assert cli.audit_failure_reason(report, 'error', fixed) is None

    # ``waived`` exists for S2; it never counts as a current failure.
    waived = _comparison(('waived', 'error'))
    assert cli.audit_failure_reason(report, 'error', waived) is None


# --- baseline comparison ----------------------------------------------------


def _baseline_file(docs, tmp_path: Path, key: str = 'findings') -> str:
    path = tmp_path / f'baseline-{key}.json'
    path.write_text(json.dumps(audit_json(docs, key), indent=2), encoding='utf-8')
    return str(path)


def test_baseline_of_the_same_report_does_not_fail_on_existing_warnings(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)

    result = run_audit(
        docs, 'findings', '--baseline', baseline, '--fail-on', 'warning', '--quiet'
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == ''
    assert result.stderr == ''


def test_new_warning_after_a_baseline_trips_fail_on_warning(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path, 'text')

    result = run_audit(
        docs, 'findings', '--baseline', baseline, '--fail-on', 'warning', '--quiet'
    )

    assert result.returncode == 1
    assert 'new or escalated' in result.stderr
    assert '2 new or escalated warning(s)' in result.stderr


def test_moved_findings_do_not_trip_fail_on(docs, tmp_path):
    report = audit_json(docs)
    report['document']['pages'] = 2
    for finding in report['findings']:
        finding['page'] = 2
    path = tmp_path / 'moved-baseline.json'
    path.write_text(json.dumps(report), encoding='utf-8')

    result = run_audit(
        docs, 'findings', '--baseline', str(path), '--fail-on', 'warning', '--quiet'
    )

    assert result.returncode == 0, result.stderr


def test_escalated_findings_trip_fail_on(docs, tmp_path):
    report = audit_json(docs)
    for finding in report['findings']:
        if finding['severity'] == 'warning':
            finding['severity'] = 'info'
    report['summary'] = {'total': 4, 'errors': 0, 'warnings': 0, 'info': 4}
    path = tmp_path / 'escalated-baseline.json'
    path.write_text(json.dumps(report), encoding='utf-8')
    output = tmp_path / 'comparison.json'

    result = run_audit(
        docs,
        'findings',
        '--baseline',
        str(path),
        '--baseline-output',
        str(output),
        '--fail-on',
        'warning',
        '--quiet',
    )

    assert result.returncode == 1
    comparison = json.loads(output.read_text(encoding='utf-8'))
    assert comparison['summary']['escalated'] == 2
    assert comparison['summary']['existing'] == 2


def test_baseline_summary_has_exactly_one_counts_line(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)

    result = run_audit(docs, 'findings', '--baseline', baseline)

    assert result.returncode == 0
    assert (
        'baseline: 0 new, 4 existing, 0 moved, 0 escalated, 0 fixed, 0 waived'
        in result.stdout
    )
    assert result.stdout.count('baseline: ') == 1


def test_without_a_baseline_the_summary_has_no_baseline_line(docs):
    result = run_audit(docs, 'findings')

    assert result.returncode == 0
    assert 'baseline:' not in result.stdout


def test_baseline_output_writes_the_comparison_contract(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    output = tmp_path / 'comparison.json'

    result = run_audit(
        docs,
        'findings',
        '--baseline',
        baseline,
        '--baseline-output',
        str(output),
        '--format',
        'json',
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(output.read_text(encoding='utf-8'))
    assert list(data) == [
        'schemaVersion',
        'tool',
        'current',
        'baseline',
        'summary',
        'findings',
    ]
    assert data['schemaVersion'] == 1
    assert data['tool']['name'] == 'pdf-inspector'
    assert data['current'] == {'pages': 1, 'findings': 4}
    assert data['baseline'] == {'pages': 1, 'findings': 4}
    assert data['summary'] == {
        'new': 0,
        'existing': 4,
        'moved': 0,
        'escalated': 0,
        'fixed': 0,
        'waived': 0,
    }
    for entry in data['findings']:
        assert entry['status'] == 'existing'
        assert re.fullmatch(r'[0-9a-f]{32}', entry['fingerprint'])
        assert entry['current'] is not None
        assert entry['baseline'] is not None
    assert docs['root'] not in output.read_text(encoding='utf-8')

    # ``--format json`` on stdout stays exactly the plain AuditReport.
    plain = json.loads(result.stdout)
    assert set(plain) == REPORT_KEYS
    assert 'status' not in result.stdout


def test_baseline_output_is_deterministic(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    first = tmp_path / 'first.json'
    second = tmp_path / 'second.json'

    for output in (first, second):
        result = run_audit(
            docs, 'findings', '--baseline', baseline, '--baseline-output', str(output)
        )
        assert result.returncode == 0, result.stderr

    assert first.read_bytes() == second.read_bytes()
    assert first.read_text(encoding='utf-8').endswith('\n')


def test_page_shifted_finding_reports_as_moved(docs, tmp_path):
    report = audit_json(docs)
    warning = next(
        finding for finding in report['findings'] if finding['severity'] == 'warning'
    )
    assert warning['page'] == 1
    shifted = {
        **warning,
        'page': 2,
        'title': warning['title'].replace('Page 1', 'Page 2').replace(
            'page 1', 'page 2'
        ),
        'detail': warning['detail'].replace('Page 1', 'Page 2').replace(
            'page 1', 'page 2'
        ),
    }
    baseline = {**report, 'findings': [shifted]}
    baseline['summary'] = {'total': 1, 'errors': 0, 'warnings': 1, 'info': 0}
    path = tmp_path / 'shifted.json'
    path.write_text(json.dumps(baseline), encoding='utf-8')
    output = tmp_path / 'comparison.json'

    result = run_audit(
        docs,
        'findings',
        '--baseline',
        str(path),
        '--baseline-output',
        str(output),
        '--quiet',
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(output.read_text(encoding='utf-8'))
    assert data['summary']['moved'] == 1
    moved = [entry for entry in data['findings'] if entry['status'] == 'moved']
    assert len(moved) == 1
    assert moved[0]['current']['page'] == 1
    assert moved[0]['baseline']['page'] == 2
    assert moved[0]['fingerprint'] == warning['fingerprint']


def test_a_comparison_artifact_is_rejected_as_a_baseline(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    comparison = tmp_path / 'comparison.json'
    first = run_audit(
        docs,
        'findings',
        '--baseline',
        baseline,
        '--baseline-output',
        str(comparison),
        '--quiet',
    )
    assert first.returncode == 0, first.stderr

    result = run_audit(docs, 'findings', '--baseline', str(comparison))

    assert result.returncode == 2
    assert result.stdout == ''
    assert 'BaselineComparison' in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_an_empty_comparison_artifact_is_rejected_as_a_baseline(docs, tmp_path):
    path = tmp_path / 'empty-comparison.json'
    path.write_text(
        json.dumps(
            {
                'schemaVersion': 1,
                'tool': {'name': 'pdf-inspector', 'version': '0.3.3'},
                'current': {'pages': 1, 'findings': 0},
                'baseline': {'pages': 1, 'findings': 0},
                'summary': {
                    'new': 0,
                    'existing': 0,
                    'moved': 0,
                    'escalated': 0,
                    'fixed': 0,
                    'waived': 0,
                },
                'findings': [],
            }
        ),
        encoding='utf-8',
    )

    result = run_audit(docs, 'text', '--baseline', str(path))

    assert result.returncode == 2
    assert result.stdout == ''
    assert 'BaselineComparison' in result.stderr
    assert 'current, baseline' in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_baseline_html_renders_the_baseline_section(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)

    result = run_audit(docs, 'findings', '--baseline', baseline, '--format', 'html')

    assert result.returncode == 0
    assert '<section id="baseline">' in result.stdout
    assert 'badge-baseline-existing' in result.stdout
    assert '<script' not in result.stdout


def test_missing_baseline_file_is_a_one_line_error(docs, tmp_path):
    result = run_audit(docs, 'text', '--baseline', str(tmp_path / 'missing.json'))

    assert result.returncode == 2
    assert result.stdout == ''
    assert result.stderr.startswith('pdf-inspector: ')
    assert 'cannot read baseline file' in result.stderr
    assert result.stderr.strip().count('\n') == 0


@pytest.mark.parametrize(
    'payload, fragment',
    [
        ('not json', 'not valid JSON'),
        ('[]', 'must contain a JSON object'),
        ('{"schemaVersion": 2, "findings": []}', 'schemaVersion 1'),
        ('{"schemaVersion": 1}', 'findings array'),
        ('{"schemaVersion": 1, "findings": [1]}', 'must be a JSON object'),
    ],
)
def test_invalid_baseline_is_a_one_line_error(docs, tmp_path, payload, fragment):
    path = tmp_path / 'baseline.json'
    path.write_text(payload, encoding='utf-8')

    result = run_audit(docs, 'text', '--baseline', str(path))

    assert result.returncode == 2
    assert result.stdout == ''
    assert result.stderr.startswith('pdf-inspector: ')
    assert fragment in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_baseline_url_is_rejected(docs):
    result = run_audit(
        docs, 'text', '--baseline', 'https://example.com/baseline.json'
    )

    assert result.returncode == 2
    assert 'local file path' in result.stderr


def test_baseline_output_requires_a_baseline(docs, tmp_path):
    result = run_audit(
        docs, 'text', '--baseline-output', str(tmp_path / 'comparison.json')
    )

    assert result.returncode == 2
    assert '--baseline-output requires --baseline' in result.stderr
    assert not (tmp_path / 'comparison.json').exists()


def test_output_cannot_overwrite_the_baseline_file(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    original = Path(baseline).read_bytes()

    result = run_audit(
        docs,
        'text',
        '--baseline',
        baseline,
        '--format',
        'json',
        '--output',
        baseline,
    )

    assert result.returncode == 2
    assert 'must not overwrite the baseline file' in result.stderr
    assert Path(baseline).read_bytes() == original


def test_baseline_output_cannot_overwrite_the_input_pdf(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    target = tmp_path / 'input.pdf'
    original = Path(docs['text']).read_bytes()
    target.write_bytes(original)

    result = run_cli(
        'audit',
        str(target),
        '--baseline',
        baseline,
        '--baseline-output',
        str(target),
    )

    assert result.returncode == 2
    assert 'must not overwrite an input PDF' in result.stderr
    assert target.read_bytes() == original


def test_baseline_output_cannot_overwrite_the_baseline_file(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    original = Path(baseline).read_bytes()

    result = run_audit(
        docs, 'text', '--baseline', baseline, '--baseline-output', baseline
    )

    assert result.returncode == 2
    assert 'must not overwrite the baseline file' in result.stderr
    assert Path(baseline).read_bytes() == original


def test_output_and_baseline_output_must_be_different_files(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    target = tmp_path / 'audit.json'
    target.write_text('sentinel', encoding='utf-8')

    result = run_audit(
        docs,
        'text',
        '--baseline',
        baseline,
        '--baseline-output',
        str(target),
        '--format',
        'json',
        '--output',
        str(target),
    )

    assert result.returncode == 2
    assert result.stdout == ''
    assert 'must be different files' in result.stderr
    assert target.read_text(encoding='utf-8') == 'sentinel'


# --- waivers ----------------------------------------------------------------

WAIVER_FUTURE = '2999-12-31'
WAIVER_PAST = '2000-01-01'


def _waiver_entry(
    fingerprint: str,
    *,
    page=None,
    reason: str = 'Legacy template; tracked in DOC-1234',
    expires: str = WAIVER_FUTURE,
) -> dict:
    entry = {'fingerprint': fingerprint, 'reason': reason, 'expires': expires}
    if page is not None:
        entry['page'] = page
    return entry


def _waiver_file(tmp_path: Path, entries, name: str = 'waivers.json') -> str:
    path = tmp_path / name
    path.write_text(
        json.dumps({'schemaVersion': 1, 'waivers': list(entries)}), encoding='utf-8'
    )
    return str(path)


def _warning_waivers(docs, tmp_path: Path, *, expires=WAIVER_FUTURE) -> str:
    """One waiver per real warning of the ``findings`` sample."""
    report = audit_json(docs)
    warnings = [
        finding for finding in report['findings'] if finding['severity'] == 'warning'
    ]
    assert len(warnings) == 2
    return _waiver_file(
        tmp_path,
        [
            _waiver_entry(finding['fingerprint'], page=finding['page'], expires=expires)
            for finding in warnings
        ],
    )


def test_waivers_alone_suppress_fail_on_warning(docs, tmp_path):
    path = _warning_waivers(docs, tmp_path)

    without = run_audit(docs, 'findings', '--fail-on', 'warning', '--quiet')
    assert without.returncode == 1

    waived = run_audit(
        docs, 'findings', '--fail-on', 'warning', '--waivers', path, '--quiet'
    )

    assert waived.returncode == 0, waived.stderr
    assert waived.stdout == ''
    assert waived.stderr == ''


def test_waivers_without_a_baseline_do_not_fabricate_baseline_counts(docs, tmp_path):
    path = _warning_waivers(docs, tmp_path)

    result = run_audit(docs, 'findings', '--waivers', path)

    assert result.returncode == 0
    assert 'baseline:' not in result.stdout
    assert result.stdout.count('waivers: 2 applied, 0 expired, 0 unused') == 1


def test_expired_waivers_are_reported_and_restore_fail_on(docs, tmp_path):
    path = _warning_waivers(docs, tmp_path, expires=WAIVER_PAST)

    result = run_audit(docs, 'findings', '--fail-on', 'warning', '--waivers', path)

    assert result.returncode == 1
    assert 'pdf-inspector: 2 waiver(s) expired and were not applied' in result.stderr
    assert '2 warning(s) found (fail-on warning)' in result.stderr
    assert 'waivers: 0 applied, 2 expired, 0 unused' in result.stdout
    assert result.stdout.count('waivers: ') == 1


def test_quiet_still_reports_expired_waivers_on_stderr(docs, tmp_path):
    path = _warning_waivers(docs, tmp_path, expires=WAIVER_PAST)

    result = run_audit(docs, 'findings', '--waivers', path, '--quiet')

    assert result.returncode == 0
    assert result.stdout == ''
    assert result.stderr == (
        'pdf-inspector: 2 waiver(s) expired and were not applied\n'
    )


def test_unused_waivers_are_counted_but_are_not_an_error(docs, tmp_path):
    path = _waiver_file(
        tmp_path,
        [_waiver_entry('a' * 32, reason='Stale policy entry')],
    )

    result = run_audit(docs, 'findings', '--waivers', path)

    assert result.returncode == 0
    assert 'waivers: 0 applied, 0 expired, 1 unused' in result.stdout
    assert result.stderr == ''


def test_page_specific_waiver_only_suppresses_its_page(docs, tmp_path):
    report = audit_json(docs)
    warning = next(
        finding for finding in report['findings'] if finding['severity'] == 'warning'
    )
    # The warning is on page 1; a waiver for page 2 must not suppress it.
    path = _waiver_file(tmp_path, [_waiver_entry(warning['fingerprint'], page=2)])

    result = run_audit(
        docs, 'findings', '--fail-on', 'warning', '--waivers', path, '--quiet'
    )

    assert result.returncode == 1
    assert 'warning(s) found (fail-on warning)' in result.stderr


def test_waived_error_does_not_trip_fail_on_error(monkeypatch, capsys, docs, tmp_path):
    finding = _extraction_failure(2)
    report = _report([finding], errors=1)
    path = _waiver_file(
        tmp_path,
        [_waiver_entry(finding_fingerprint(finding), page=2)],
    )

    monkeypatch.setattr(cli, 'audit_file', lambda path: report)

    assert cli.main(['audit', docs['text'], '--fail-on', 'error', '--quiet']) == 1
    capsys.readouterr()
    assert (
        cli.main(
            [
                'audit',
                docs['text'],
                '--fail-on',
                'error',
                '--waivers',
                path,
                '--quiet',
            ]
        )
        == 0
    )
    assert capsys.readouterr().err == ''


def test_json_stays_the_plain_report_when_waivers_are_loaded(docs, tmp_path):
    path = _warning_waivers(docs, tmp_path)

    result = run_audit(docs, 'findings', '--format', 'json', '--waivers', path)

    assert result.returncode == 0, result.stderr
    assert result.stdout == json.dumps(audit_json(docs), indent=2, ensure_ascii=False) + '\n'
    data = json.loads(result.stdout)
    assert set(data) == REPORT_KEYS
    assert 'waived' not in result.stdout and 'waiver' not in result.stdout


def test_html_with_waivers_renders_the_waivers_section(docs, tmp_path):
    path = _warning_waivers(docs, tmp_path)

    result = run_audit(docs, 'findings', '--format', 'html', '--waivers', path)

    assert result.returncode == 0
    assert '<section id="waivers">' in result.stdout
    assert 'badge-waived' in result.stdout
    assert '<script' not in result.stdout
    assert path not in result.stdout


def test_waivers_with_a_baseline_mark_new_warnings_waived(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path, 'text')
    path = _warning_waivers(docs, tmp_path)
    output = tmp_path / 'comparison.json'

    result = run_audit(
        docs,
        'findings',
        '--baseline',
        baseline,
        '--baseline-output',
        str(output),
        '--waivers',
        path,
        '--fail-on',
        'warning',
        '--quiet',
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(output.read_text(encoding='utf-8'))
    assert list(data) == [
        'schemaVersion',
        'tool',
        'current',
        'baseline',
        'summary',
        'waivers',
        'findings',
    ]
    assert data['summary']['waived'] == 2
    assert data['summary']['new'] == 0
    assert data['summary']['escalated'] == 0
    assert data['waivers'] == {'applied': 2, 'expired': 0, 'unused': 0}
    waived_entries = [
        entry for entry in data['findings'] if entry['status'] == 'waived'
    ]
    assert len(waived_entries) == 2
    for entry in waived_entries:
        assert entry['waiver']['reason'] == 'Legacy template; tracked in DOC-1234'
        assert entry['waiver']['expires'] == WAIVER_FUTURE
    assert str(tmp_path) not in output.read_text(encoding='utf-8')


def test_expired_waivers_with_a_baseline_leave_the_findings_new(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path, 'text')
    path = _warning_waivers(docs, tmp_path, expires=WAIVER_PAST)
    output = tmp_path / 'comparison.json'

    result = run_audit(
        docs,
        'findings',
        '--baseline',
        baseline,
        '--baseline-output',
        str(output),
        '--waivers',
        path,
        '--fail-on',
        'warning',
        '--quiet',
    )

    assert result.returncode == 1
    data = json.loads(output.read_text(encoding='utf-8'))
    assert data['summary']['waived'] == 0
    assert data['summary']['new'] == 2
    assert data['waivers'] == {'applied': 0, 'expired': 2, 'unused': 0}


def test_baseline_without_waivers_has_no_waivers_block(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    output = tmp_path / 'comparison.json'

    result = run_audit(
        docs, 'findings', '--baseline', baseline, '--baseline-output', str(output)
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(output.read_text(encoding='utf-8'))
    assert 'waivers' not in data
    assert 'waivers:' not in result.stdout


def test_baseline_summary_has_one_baseline_line_and_one_waiver_line(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    path = _warning_waivers(docs, tmp_path)

    result = run_audit(
        docs, 'findings', '--baseline', baseline, '--waivers', path
    )

    assert result.returncode == 0
    lines = result.stdout.splitlines()
    baseline_index = next(
        index for index, line in enumerate(lines) if line.startswith('baseline: ')
    )
    assert lines[baseline_index + 1] == 'waivers: 2 applied, 0 expired, 0 unused'
    assert result.stdout.count('baseline: ') == 1
    assert result.stdout.count('waivers: ') == 1


@pytest.mark.parametrize(
    'payload, fragment',
    [
        ('not json', 'not valid JSON'),
        ('[]', 'must contain a JSON object'),
        ('{"schemaVersion": 2, "waivers": []}', 'schemaVersion 1'),
        ('{"schemaVersion": 1}', 'waivers array'),
        ('{"schemaVersion": 1, "waivers": [1]}', 'must be a JSON object'),
        (
            '{"schemaVersion": 1, "waivers": [{"fingerprint": "ABC", '
            '"reason": "why", "expires": "2999-01-01"}]}',
            '32 lowercase hex',
        ),
        (
            '{"schemaVersion": 1, "waivers": [{"fingerprint": "'
            + '0' * 32
            + '", "reason": "why", "expires": "2999-13-01"}]}',
            'expires',
        ),
    ],
)
def test_invalid_waiver_file_is_a_one_line_error(docs, tmp_path, payload, fragment):
    path = tmp_path / 'waivers.json'
    path.write_text(payload, encoding='utf-8')

    result = run_audit(docs, 'text', '--waivers', str(path))

    assert result.returncode == 2
    assert result.stdout == ''
    assert result.stderr.startswith('pdf-inspector: ')
    assert fragment in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_missing_waiver_file_is_a_one_line_error(docs, tmp_path):
    result = run_audit(docs, 'text', '--waivers', str(tmp_path / 'missing.json'))

    assert result.returncode == 2
    assert result.stdout == ''
    assert 'cannot read waivers file' in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_waiver_url_is_rejected(docs):
    result = run_audit(docs, 'text', '--waivers', 'https://example.com/waivers.json')

    assert result.returncode == 2
    assert 'local file path' in result.stderr
    assert result.stdout == ''


def test_output_cannot_overwrite_the_waivers_file(docs, tmp_path):
    path = _warning_waivers(docs, tmp_path)
    original = Path(path).read_bytes()

    result = run_audit(
        docs,
        'findings',
        '--waivers',
        path,
        '--format',
        'json',
        '--output',
        path,
    )

    assert result.returncode == 2
    assert 'must not overwrite the waivers file' in result.stderr
    assert Path(path).read_bytes() == original


def test_baseline_output_cannot_overwrite_the_waivers_file(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    path = _warning_waivers(docs, tmp_path)
    original = Path(path).read_bytes()

    result = run_audit(
        docs,
        'findings',
        '--baseline',
        baseline,
        '--waivers',
        path,
        '--baseline-output',
        path,
    )

    assert result.returncode == 2
    assert 'must not overwrite the waivers file' in result.stderr
    assert Path(path).read_bytes() == original


def test_baseline_output_still_requires_a_baseline_with_waivers(docs, tmp_path):
    path = _warning_waivers(docs, tmp_path)

    result = run_audit(
        docs, 'findings', '--waivers', path, '--baseline-output', str(tmp_path / 'c.json')
    )

    assert result.returncode == 2
    assert '--baseline-output requires --baseline' in result.stderr
    assert not (tmp_path / 'c.json').exists()


# --- SARIF output -----------------------------------------------------------

SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'


def sarif_json(docs, key: str = 'findings', *args: str) -> dict:
    result = run_audit(docs, key, '--format', 'sarif', *args)
    assert result.returncode == 0, result.stderr
    assert result.stderr == ''
    return json.loads(result.stdout)


def _sarif_results(data: dict) -> list:
    return data['runs'][0]['results']


def test_sarif_on_stdout_is_a_valid_2_1_0_document(docs):
    data = sarif_json(docs)

    assert list(data) == ['$schema', 'version', 'runs']
    assert data['$schema'] == SARIF_SCHEMA
    assert data['version'] == '2.1.0'
    assert len(data['runs']) == 1

    run = data['runs'][0]
    assert run['columnKind'] == 'utf16CodeUnits'
    driver = run['tool']['driver']
    assert driver['name'] == 'pdf-inspector'
    assert re.fullmatch(r'\d+\.\d+\.\d+', driver['version'])
    assert driver['informationUri'] == 'https://github.com/EthanCheung-gh/pdf-inspector'
    assert driver['rules']

    results = _sarif_results(data)
    assert len(results) == 4
    for result in results:
        assert {'ruleId', 'ruleIndex', 'level', 'message', 'partialFingerprints'} <= set(
            result
        )
        assert result['level'] in ('error', 'warning', 'note')
        assert result['message']['text']
        assert re.fullmatch(
            r'[0-9a-f]{32}', result['partialFingerprints']['pdfInspectorFinding/v1']
        )
        assert driver['rules'][result['ruleIndex']]['id'] == result['ruleId']

    # The sample has two warnings and two info findings.
    assert sorted(result['level'] for result in results) == [
        'note',
        'note',
        'warning',
        'warning',
    ]


def test_sarif_maps_page_and_document_level_findings(docs):
    data = sarif_json(docs)

    by_rule = {result['ruleId']: result for result in _sarif_results(data)}
    page_result = by_rule['pdf-inspector/images/page-1-has-images-but-no-extractable-text']
    location = page_result['locations'][0]['physicalLocation']
    assert location['artifactLocation'] == {'uri': docs['findings'].replace('\\', '/')}
    assert location['region'] == {'startPage': 1}

    document_result = by_rule['pdf-inspector/metadata/missing-document-language']
    assert 'locations' not in document_result


def test_sarif_output_file_equals_the_stdout_payload_and_keeps_the_summary(docs, tmp_path):
    output = tmp_path / 'audit.sarif'
    result = run_audit(docs, 'findings', '--format', 'sarif', '--output', str(output))

    assert result.returncode == 0, result.stderr
    assert not result.stdout.lstrip().startswith('{')
    assert 'summary: 0 errors, 2 warnings, 2 info (4 total)' in result.stdout
    assert json.loads(output.read_text(encoding='utf-8')) == sarif_json(docs)
    assert output.read_text(encoding='utf-8').endswith('\n')


def test_sarif_output_file_uses_lf(docs, tmp_path):
    output = tmp_path / 'audit.sarif'
    result = run_audit(docs, 'findings', '--format', 'sarif', '--output', str(output))

    assert result.returncode == 0, result.stderr
    assert b'\r\n' not in output.read_bytes()


def test_sarif_quiet_with_output_writes_the_file_without_stdout(docs, tmp_path):
    output = tmp_path / 'audit.sarif'
    result = run_audit(
        docs, 'findings', '--format', 'sarif', '--output', str(output), '--quiet'
    )

    assert result.returncode == 0
    assert result.stdout == ''
    assert json.loads(output.read_text(encoding='utf-8'))['version'] == '2.1.0'


def test_sarif_uri_overrides_the_artifact_location(docs):
    data = sarif_json(docs, 'findings', '--sarif-uri', 'docs/report.pdf')

    uris = {
        result['locations'][0]['physicalLocation']['artifactLocation']['uri']
        for result in _sarif_results(data)
        if 'locations' in result
    }
    assert uris == {'docs/report.pdf'}


def test_sarif_uri_requires_the_sarif_format(docs):
    result = run_audit(
        docs, 'findings', '--format', 'json', '--sarif-uri', 'docs/report.pdf'
    )

    assert result.returncode == 2
    assert result.stdout == ''
    assert result.stderr.startswith('pdf-inspector: ')
    assert '--sarif-uri requires --format sarif' in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_empty_sarif_uri_is_rejected(docs):
    result = run_audit(docs, 'findings', '--format', 'sarif', '--sarif-uri', '')

    assert result.returncode == 2
    assert result.stdout == ''
    assert '--sarif-uri must not be empty' in result.stderr


def test_sarif_does_not_embed_the_workspace_path_when_the_uri_is_relative(docs, tmp_path):
    output = tmp_path / 'audit.sarif'
    result = run_audit(
        docs,
        'findings',
        '--format',
        'sarif',
        '--output',
        str(output),
        '--sarif-uri',
        'web-samples/basic.pdf',
    )

    assert result.returncode == 0, result.stderr
    text = output.read_text(encoding='utf-8')
    assert docs['root'] not in text
    assert 'web-samples/basic.pdf' in text


def test_sarif_maps_the_baseline_state(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    data = sarif_json(docs, 'findings', '--baseline', baseline)

    states = [result.get('baselineState') for result in _sarif_results(data)]
    assert states == ['unchanged'] * 4


def test_sarif_marks_findings_missing_from_the_baseline_as_new(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path, 'text')
    data = sarif_json(docs, 'findings', '--baseline', baseline)

    results = _sarif_results(data)
    warnings = [result for result in results if result['level'] == 'warning']
    assert [result['baselineState'] for result in warnings] == ['new', 'new']
    assert all(
        result['baselineState'] in ('new', 'unchanged') for result in results
    )


def test_sarif_maps_waivers_to_suppressions_and_keeps_fail_on_quiet(docs, tmp_path):
    path = _warning_waivers(docs, tmp_path)
    baseline = _baseline_file(docs, tmp_path, 'text')
    output = tmp_path / 'audit.sarif'

    result = run_audit(
        docs,
        'findings',
        '--format',
        'sarif',
        '--output',
        str(output),
        '--baseline',
        baseline,
        '--waivers',
        path,
        '--fail-on',
        'warning',
        '--quiet',
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(output.read_text(encoding='utf-8'))
    suppressed = [
        result for result in _sarif_results(data) if 'suppressions' in result
    ]
    assert len(suppressed) == 2
    for entry in suppressed:
        assert entry['suppressions'] == [
            {
                'kind': 'external',
                'status': 'accepted',
                'justification': 'Legacy template; tracked in DOC-1234',
            }
        ]
        assert 'baselineState' not in entry


def test_sarif_without_waivers_has_no_suppressions(docs, tmp_path):
    data = sarif_json(docs, 'findings', '--baseline', _baseline_file(docs, tmp_path))

    assert all('suppressions' not in result for result in _sarif_results(data))


def test_sarif_keeps_the_fail_on_exit_code(docs, tmp_path):
    output = tmp_path / 'audit.sarif'
    result = run_audit(
        docs,
        'findings',
        '--format',
        'sarif',
        '--output',
        str(output),
        '--fail-on',
        'warning',
    )

    assert result.returncode == 1
    assert 'fail-on warning' in result.stderr
    # The payload is written before the exit code is decided.
    assert json.loads(output.read_text(encoding='utf-8'))['version'] == '2.1.0'


def test_sarif_is_deterministic_across_runs(docs):
    first = run_audit(docs, 'findings', '--format', 'sarif')
    second = run_audit(docs, 'findings', '--format', 'sarif')

    assert first.returncode == second.returncode == 0
    assert first.stdout == second.stdout
    assert not re.search(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', first.stdout)


def test_sarif_output_cannot_overwrite_the_baseline_file(docs, tmp_path):
    baseline = _baseline_file(docs, tmp_path)
    original = Path(baseline).read_bytes()

    result = run_audit(
        docs,
        'findings',
        '--format',
        'sarif',
        '--baseline',
        baseline,
        '--output',
        baseline,
    )

    assert result.returncode == 2
    assert 'must not overwrite the baseline file' in result.stderr
    assert Path(baseline).read_bytes() == original


def test_only_audit_accepts_the_sarif_format():
    parser = cli.build_parser()

    assert cli.FORMAT_CHOICES == ('summary', 'json', 'html')
    assert cli.AUDIT_FORMAT_CHOICES == ('summary', 'json', 'html', 'sarif')

    for argv in (
        ['diff', 'old.pdf', 'new.pdf'],
        ['security', 'sample.pdf'],
        ['accessibility', 'sample.pdf'],
    ):
        with pytest.raises(SystemExit):
            parser.parse_args([*argv, '--format', 'sarif'])

    args = parser.parse_args(['audit', 'sample.pdf', '--format', 'sarif'])
    assert args.format == 'sarif'


# --- usage / read / audit errors --------------------------------------------


def test_unknown_format_is_a_usage_error(docs):
    result = run_audit(docs, 'text', '--format', 'yaml')

    assert result.returncode == 2
    assert 'invalid choice' in result.stderr.lower()
    assert result.stdout == ''


def test_unknown_fail_on_is_a_usage_error(docs):
    result = run_audit(docs, 'text', '--fail-on', 'sometimes')

    assert result.returncode == 2
    assert result.stdout == ''


def test_missing_file_argument_is_a_usage_error():
    result = run_cli('audit')

    assert result.returncode == 2
    assert 'usage' in result.stderr.lower()
    assert result.stdout == ''


def test_missing_file_is_a_one_line_error():
    result = run_cli('audit', '/definitely/not/here.pdf')

    assert result.returncode == 2
    assert result.stdout == ''
    assert 'not found' in result.stderr
    assert 'Traceback' not in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_directory_input_is_rejected(docs, tmp_path):
    result = run_cli('audit', str(tmp_path))

    assert result.returncode == 2
    assert 'not a file' in result.stderr


def test_non_pdf_input_is_rejected(docs):
    result = run_audit(docs, 'not_pdf')

    assert result.returncode == 2
    assert 'not a PDF' in result.stderr
    assert result.stdout == ''
    assert result.stderr.strip().count('\n') == 0


def test_http_url_input_is_rejected_without_network():
    result = run_cli('audit', 'https://example.com/sample.pdf')

    assert result.returncode == 2
    assert 'local file path' in result.stderr
    assert 'URL' in result.stderr
    assert result.stdout == ''


def test_malformed_pdf_is_an_audit_error(docs):
    result = run_audit(docs, 'broken')

    assert result.returncode == 2
    assert 'Traceback' not in result.stderr
    assert result.stderr.strip().count('\n') == 0
    assert result.stdout == ''


def test_output_to_missing_directory_fails(docs, tmp_path):
    missing = tmp_path / 'missing-dir' / 'audit.json'
    result = run_audit(docs, 'text', '--format', 'json', '--output', str(missing))

    assert result.returncode == 2
    assert 'output directory does not exist' in result.stderr


def test_output_to_directory_path_fails(docs, tmp_path):
    result = run_audit(docs, 'text', '--format', 'json', '--output', str(tmp_path))

    assert result.returncode == 2
    assert 'directory' in result.stderr


def test_output_cannot_overwrite_the_input_pdf(docs, tmp_path):
    target = tmp_path / 'input.pdf'
    original = Path(docs['text']).read_bytes()
    target.write_bytes(original)

    result = run_cli(
        'audit',
        str(target),
        '--format',
        'json',
        '--output',
        str(target),
    )

    assert result.returncode == 2
    assert 'must not overwrite an input PDF' in result.stderr
    assert target.read_bytes() == original


# --- parser wiring ----------------------------------------------------------


def test_audit_parser_defaults():
    args = cli.build_parser().parse_args(['audit', 'sample.pdf'])

    assert args.command == 'audit'
    assert args.file == 'sample.pdf'
    assert args.format == 'summary'
    assert args.output is None
    assert args.baseline is None
    assert args.baseline_output is None
    assert args.waivers is None
    assert args.fail_on == 'none'
    assert args.sarif_uri is None
    assert args.quiet is False


def test_diff_parser_defaults_are_unchanged():
    args = cli.build_parser().parse_args(['diff', 'old.pdf', 'new.pdf'])

    assert args.command == 'diff'
    assert args.format == 'summary'
    assert args.fail_on == 'any'
    assert args.quiet is False
