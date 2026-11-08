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
    assert args.fail_on == 'none'
    assert args.quiet is False


def test_diff_parser_defaults_are_unchanged():
    args = cli.build_parser().parse_args(['diff', 'old.pdf', 'new.pdf'])

    assert args.command == 'diff'
    assert args.format == 'summary'
    assert args.fail_on == 'any'
    assert args.quiet is False
