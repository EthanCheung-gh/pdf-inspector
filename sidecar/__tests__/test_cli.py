"""``pdf-inspector diff`` CLI: output formats, exit codes, validation, wrapper."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import A4, letter
from reportlab.pdfgen import canvas as rl_canvas

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI = REPO_ROOT / 'sidecar' / 'cli.py'
WRAPPER = REPO_ROOT / 'bin' / 'pdf-inspector.mjs'

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cli  # noqa: E402

CHANGE_KEYS = {
    'kind',
    'type',
    'oldPage',
    'newPage',
    'oldBBox',
    'newBBox',
    'textOld',
    'textNew',
    'details',
}
PAGE_KEYS = {'oldIndex', 'newIndex', 'status', 'oldSize', 'newSize', 'changes'}
SUMMARY_KEYS = {
    'pagesAdded',
    'pagesRemoved',
    'pagesChanged',
    'objectsAdded',
    'objectsRemoved',
    'objectsMoved',
    'objectsModified',
}


# --- fixtures ---------------------------------------------------------------


def _draw_text(text: str, x: float = 100, y: float = 700):
    def draw(canvas) -> None:
        canvas.setFont('Helvetica', 12)
        canvas.drawString(x, y, text)

    return draw


def _draw_rect(x: float, y: float = 500):
    def draw(canvas) -> None:
        canvas.rect(x, y, 60, 40)

    return draw


def _page(*draws):
    def draw(canvas) -> None:
        for item in draws:
            item(canvas)

    return draw


def _pdf(path: Path, *pages, pagesize=letter) -> str:
    canvas = rl_canvas.Canvas(str(path), pagesize=pagesize)
    for draw in pages:
        draw(canvas)
        canvas.showPage()
    canvas.save()
    return str(path)


@pytest.fixture(scope='module')
def docs(tmp_path_factory):
    root = tmp_path_factory.mktemp('cli-docs')

    def build(name: str, *pages, pagesize=letter) -> str:
        return _pdf(root / name, *pages, pagesize=pagesize)

    not_pdf = root / 'not_pdf.txt'
    not_pdf.write_bytes(b'this is plain text, not a pdf\n')
    broken = root / 'broken.pdf'
    broken.write_bytes(b'%PDF-1.4\nthis is not a real pdf body\n')

    return {
        # identical documents
        'same_a': build('same_a.pdf', _page(_draw_text('Hello World'), _draw_rect(300))),
        'same_b': build('same_b.pdf', _page(_draw_text('Hello World'), _draw_rect(300))),
        # one modified word
        'changed_a': build('changed_a.pdf', _page(_draw_text('Alpha'))),
        'changed_b': build('changed_b.pdf', _page(_draw_text('Beta'))),
        # 1:1 character replacement: modified objects only, nothing added/removed
        'modified_a': build('modified_a.pdf', _page(_draw_text('Cat'))),
        'modified_b': build('modified_b.pdf', _page(_draw_text('Dog'))),
        # one added rectangle, everything else identical
        'extra_a': build('extra_a.pdf', _page(_draw_text('Stable'))),
        'extra_b': build('extra_b.pdf', _page(_draw_text('Stable'), _draw_rect(300, 300))),
        # one removed rectangle, everything else identical
        'missing_a': build('missing_a.pdf', _page(_draw_text('Stable'), _draw_rect(300, 300))),
        'missing_b': build('missing_b.pdf', _page(_draw_text('Stable'))),
        # page insert/remove
        'two_pages': build(
            'two_pages.pdf',
            _page(_draw_text('Page One')),
            _page(_draw_text('Page Two')),
        ),
        'one_page': build('one_page.pdf', _page(_draw_text('Page One'))),
        # page geometry change (page count unchanged)
        'letter': build('letter.pdf', _page(_draw_text('Resized')), pagesize=letter),
        'a4': build('a4.pdf', _page(_draw_text('Resized')), pagesize=A4),
        'not_pdf': str(not_pdf),
        'broken': str(broken),
    }


PAIRS = {
    'same': ('same_a', 'same_b'),
    'changed': ('changed_a', 'changed_b'),
    'pure_modified': ('modified_a', 'modified_b'),
    'extra': ('extra_a', 'extra_b'),
    'missing': ('missing_a', 'missing_b'),
    'page_removed': ('two_pages', 'one_page'),
    'page_added': ('one_page', 'two_pages'),
    'geometry': ('letter', 'a4'),
}


def run_cli(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True,
        text=True,
        cwd=str(cwd or REPO_ROOT),
    )


def run_pair(docs, pair: str, *args: str) -> subprocess.CompletedProcess:
    old_key, new_key = PAIRS[pair]
    return run_cli('diff', docs[old_key], docs[new_key], *args)


def _json_result(docs, pair: str = 'changed', *args: str) -> dict:
    result = run_pair(docs, pair, '--format', 'json', '--fail-on', 'none', *args)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# --- JSON output ------------------------------------------------------------


def test_json_output_matches_contract(docs):
    data = _json_result(docs, 'changed')

    assert set(data) == {'schemaVersion', 'tool', 'options', 'old', 'new', 'summary', 'pages'}
    assert data['schemaVersion'] == 1
    assert data['tool']['name'] == 'pdf-inspector'
    assert re.fullmatch(r'\d+\.\d+\.\d+', data['tool']['version'])
    assert set(data['summary']) == SUMMARY_KEYS
    assert data['summary']['objectsModified'] >= 1
    assert data['old']['pages'] == 1 and data['new']['pages'] == 1
    assert len(data['old']['sha256']) == 64 and len(data['new']['sha256']) == 64
    assert set(data['options']) == {
        'positionTolerance',
        'textTolerance',
        'ignoreTypes',
        'ignoreFonts',
        'ignoreColors',
        'ignoreImages',
    }

    for page in data['pages']:
        assert set(page) == PAGE_KEYS
        assert page['status'] in ('added', 'removed', 'changed', 'unchanged')
        for change in page['changes']:
            assert set(change) == CHANGE_KEYS
            assert change['kind'] in ('added', 'removed', 'moved', 'modified')


def test_json_output_is_pure_json_on_stdout(docs):
    result = run_pair(docs, 'changed', '--format', 'json', '--fail-on', 'none')

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.lstrip().startswith('{')
    json.loads(result.stdout)  # must parse without stripping a summary


def test_json_options_flags_are_forwarded(docs):
    data = _json_result(
        docs,
        'changed',
        '--position-tolerance',
        '2.5',
        '--text-tolerance',
        'exact',
        '--ignore-types',
        'image,char',
        '--ignore-fonts',
        '--ignore-colors',
        '--ignore-images',
    )

    assert data['options'] == {
        'positionTolerance': 2.5,
        'textTolerance': 'exact',
        'ignoreTypes': ['char', 'image'],
        'ignoreFonts': True,
        'ignoreColors': True,
        'ignoreImages': True,
    }
    assert all(
        change['type'] not in ('char', 'image')
        for page in data['pages']
        for change in page['changes']
    )


# --- summary output ---------------------------------------------------------


def test_summary_is_the_default_and_exits_zero_for_same_docs(docs):
    result = run_pair(docs, 'same')

    assert result.returncode == 0
    assert result.stderr == ''
    assert 'pdf-inspector' in result.stdout
    assert 'pages: 1 -> 1' in result.stdout
    assert 'objects: 0 added, 0 removed, 0 moved, 0 modified' in result.stdout
    assert 'documents match' in result.stdout


def test_default_fail_on_any_exits_one_for_changed_docs(docs):
    result = run_pair(docs, 'changed')

    assert result.returncode == 1
    assert 'pdf-inspector' in result.stdout  # summary still printed
    assert '"Alpha" -> "Beta"' in result.stdout
    assert 'detected (fail-on any)' in result.stderr


def test_quiet_suppresses_human_summary_only(docs):
    quiet_summary = run_pair(docs, 'same', '--quiet')
    assert quiet_summary.returncode == 0
    assert quiet_summary.stdout == ''
    assert quiet_summary.stderr == ''

    quiet_json = run_pair(docs, 'changed', '--format', 'json', '--fail-on', 'none', '--quiet')
    assert quiet_json.returncode == 0
    assert json.loads(quiet_json.stdout)['summary']['objectsModified'] >= 1


def test_quiet_with_output_writes_file_without_stdout(docs, tmp_path):
    output = tmp_path / 'diff.json'
    result = run_pair(
        docs, 'changed', '--format', 'json', '--output', str(output), '--quiet', '--fail-on', 'none'
    )

    assert result.returncode == 0
    assert result.stdout == ''
    assert json.loads(output.read_text(encoding='utf-8'))['schemaVersion'] == 1


# --- --output ---------------------------------------------------------------


def test_output_json_file_and_summary_on_stdout(docs, tmp_path):
    output = tmp_path / 'diff.json'
    result = run_pair(
        docs, 'changed', '--format', 'json', '--output', str(output), '--fail-on', 'none'
    )

    assert result.returncode == 0
    assert result.stderr == ''
    assert not result.stdout.lstrip().startswith('{')
    assert 'pages:' in result.stdout

    written = json.loads(output.read_text(encoding='utf-8'))
    stdout_run = _json_result(docs, 'changed')
    assert written == stdout_run
    assert written['summary']['objectsModified'] >= 1


def test_output_html_file_is_standalone(docs, tmp_path):
    output = tmp_path / 'report.html'
    result = run_pair(
        docs, 'changed', '--format', 'html', '--output', str(output), '--fail-on', 'none'
    )

    assert result.returncode == 0
    assert 'pages:' in result.stdout
    content = output.read_text(encoding='utf-8')
    assert content.startswith('<!DOCTYPE html>')
    assert '<style>' in content
    assert '<script' not in content
    assert 'Pages added' in content
    assert 'Diff options' in content


def test_html_format_on_stdout_has_no_summary_mixed_in(docs):
    result = run_pair(docs, 'changed', '--format', 'html', '--fail-on', 'none')

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.startswith('<!DOCTYPE html>')
    assert '\nold: ' not in result.stdout


# --- --fail-on exit codes ---------------------------------------------------


@pytest.mark.parametrize(
    'pair, fail_on, expected',
    [
        ('same', 'any', 0),
        ('same', 'modified', 0),
        ('same', 'none', 0),
        ('changed', 'any', 1),
        ('changed', 'modified', 1),
        ('changed', 'none', 0),
        ('pure_modified', 'modified', 1),
        ('pure_modified', 'added', 0),
        ('pure_modified', 'removed', 0),
        ('pure_modified', 'page-count', 0),
        ('extra', 'added', 1),
        ('extra', 'removed', 0),
        ('extra', 'modified', 0),
        ('extra', 'page-count', 0),
        ('missing', 'removed', 1),
        ('missing', 'added', 0),
        ('missing', 'modified', 0),
        ('page_added', 'page-count', 1),
        ('page_added', 'added', 1),
        ('page_removed', 'page-count', 1),
        ('page_removed', 'removed', 1),
        ('page_removed', 'added', 0),
        ('page_removed', 'modified', 0),
        ('geometry', 'page-count', 1),
        ('geometry', 'modified', 1),
        ('geometry', 'added', 0),
    ],
)
def test_fail_on_modes(docs, pair, fail_on, expected):
    result = run_pair(docs, pair, '--fail-on', fail_on, '--quiet')

    assert result.returncode == expected, result.stderr
    if expected:
        assert 'fail-on' in result.stderr
    else:
        assert result.stderr == ''


def test_failure_reason_helper_covers_page_only_changes():
    result = {
        'old': {'pages': 1},
        'new': {'pages': 2},
        'summary': {
            'pagesAdded': 1,
            'pagesRemoved': 0,
            'pagesChanged': 0,
            'objectsAdded': 0,
            'objectsRemoved': 0,
            'objectsMoved': 0,
            'objectsModified': 0,
        },
        'pages': [
            {
                'oldIndex': None,
                'newIndex': 2,
                'status': 'added',
                'oldSize': None,
                'newSize': {'width': 612.0, 'height': 792.0},
                'changes': [],
            }
        ],
    }

    assert cli.failure_reason(result, 'none') is None
    assert '1 page(s)' in cli.failure_reason(result, 'added')
    assert cli.failure_reason(result, 'removed') is None
    assert cli.failure_reason(result, 'modified') is None
    assert cli.failure_reason(result, 'page-count') is not None
    assert cli.failure_reason(result, 'any') is not None


# --- usage / read errors ----------------------------------------------------


def test_no_command_is_a_usage_error():
    result = run_cli()

    assert result.returncode == 2
    assert 'usage' in result.stderr.lower()
    assert result.stdout == ''


def test_unknown_format_is_a_usage_error(docs):
    result = run_pair(docs, 'same', '--format', 'yaml')

    assert result.returncode == 2
    assert 'invalid choice' in result.stderr.lower()


def test_unknown_fail_on_is_a_usage_error(docs):
    result = run_pair(docs, 'same', '--fail-on', 'sometimes')

    assert result.returncode == 2


def test_invalid_text_tolerance_is_a_usage_error(docs):
    result = run_pair(docs, 'same', '--text-tolerance', 'fuzzy')

    assert result.returncode == 2


def test_negative_position_tolerance_is_a_usage_error(docs):
    result = run_pair(docs, 'same', '--position-tolerance', '-1')

    assert result.returncode == 2


def test_unknown_ignore_type_is_reported_clearly(docs):
    result = run_pair(docs, 'same', '--ignore-types', 'pixel')

    assert result.returncode == 2
    assert 'Unknown ignore type' in result.stderr
    assert result.stdout == ''
    assert 'Traceback' not in result.stderr


def test_missing_file_is_a_one_line_error(docs):
    result = run_cli('diff', '/definitely/not/here.pdf', docs['same_b'])

    assert result.returncode == 2
    assert result.stdout == ''
    assert 'not found' in result.stderr
    assert 'Traceback' not in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_directory_input_is_rejected(docs, tmp_path):
    result = run_cli('diff', str(tmp_path), docs['same_b'])

    assert result.returncode == 2
    assert 'not a file' in result.stderr


def test_non_pdf_input_is_rejected(docs):
    result = run_cli('diff', docs['not_pdf'], docs['same_b'])

    assert result.returncode == 2
    assert 'not a PDF' in result.stderr
    assert result.stdout == ''
    assert result.stderr.strip().count('\n') == 0


def test_http_url_input_is_rejected_without_network(docs):
    result = run_cli('diff', 'https://example.com/old.pdf', docs['same_b'])

    assert result.returncode == 2
    assert 'local file path' in result.stderr
    assert 'URL' in result.stderr
    assert result.stdout == ''


def test_malformed_pdf_reports_diff_error(docs):
    result = run_cli('diff', docs['same_a'], docs['broken'])

    assert result.returncode == 2
    assert 'PDF' in result.stderr
    assert 'Traceback' not in result.stderr
    assert result.stderr.strip().count('\n') == 0
    assert result.stdout == ''


def test_output_to_missing_directory_fails(docs, tmp_path):
    missing = tmp_path / 'missing-dir' / 'diff.json'
    result = run_pair(
        docs, 'same', '--format', 'json', '--output', str(missing), '--fail-on', 'none'
    )

    assert result.returncode == 2
    assert 'output directory does not exist' in result.stderr


def test_output_to_directory_path_fails(docs, tmp_path):
    result = run_pair(
        docs, 'same', '--format', 'json', '--output', str(tmp_path), '--fail-on', 'none'
    )

    assert result.returncode == 2
    assert 'directory' in result.stderr


def test_output_cannot_overwrite_an_input_pdf(docs, tmp_path):
    target = tmp_path / 'input.pdf'
    target.write_bytes(Path(docs['same_a']).read_bytes())

    result = run_cli(
        'diff',
        str(target),
        docs['same_b'],
        '--format',
        'json',
        '--output',
        str(target),
        '--fail-on',
        'none',
    )

    assert result.returncode == 2
    assert 'must not overwrite an input PDF' in result.stderr
    assert target.read_bytes().startswith(b'%PDF-')


# --- version ----------------------------------------------------------------


def test_version_flag_prints_package_version():
    result = run_cli('--version')

    assert result.returncode == 0
    assert re.fullmatch(r'pdf-inspector \d+\.\d+\.\d+\n', result.stdout)


# --- Node wrapper -----------------------------------------------------------

NODE = shutil.which('node')
skip_without_node = pytest.mark.skipif(NODE is None, reason='node is not installed')


def test_node_wrapper_is_executable_with_shebang():
    content = WRAPPER.read_text(encoding='utf-8')
    assert content.startswith('#!/usr/bin/env node')
    if os.name == 'posix':
        assert os.access(WRAPPER, os.X_OK)


@skip_without_node
def test_node_wrapper_forwards_version():
    result = subprocess.run(
        [NODE, str(WRAPPER), '--version'], capture_output=True, text=True
    )

    assert result.returncode == 0
    assert re.fullmatch(r'pdf-inspector \d+\.\d+\.\d+\n', result.stdout)
    assert result.stderr == ''


@skip_without_node
def test_node_wrapper_forwards_diff_arguments_and_exit_code(docs):
    result = subprocess.run(
        [
            NODE,
            str(WRAPPER),
            'diff',
            docs['changed_a'],
            docs['changed_b'],
            '--format',
            'json',
            '--fail-on',
            'none',
        ],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert data['tool']['name'] == 'pdf-inspector'

    failing = subprocess.run(
        [NODE, str(WRAPPER), 'diff', docs['changed_a'], docs['changed_b'], '--quiet'],
        capture_output=True,
        text=True,
    )
    assert failing.returncode == 1
    assert 'fail-on any' in failing.stderr


@skip_without_node
def test_node_wrapper_reports_missing_python_interpreter():
    env = dict(os.environ, PDF_INSPECTOR_PYTHON='/definitely/not/a/python')
    result = subprocess.run(
        [NODE, str(WRAPPER), '--version'], capture_output=True, text=True, env=env
    )

    assert result.returncode == 127
    assert 'failed to start' in result.stderr
    assert 'PDF_INSPECTOR_PYTHON' in result.stderr


@skip_without_node
def test_node_wrapper_python_resolution_helper():
    wrapper_url = WRAPPER.as_uri()
    script = (
        f'import({json.dumps(wrapper_url)}).then((m) => {{'
        "  const override = m.resolvePython({"
        "    env: { PDF_INSPECTOR_PYTHON: '/custom/python' },"
        "    root: '/nowhere', isFile: () => false,"
        '  });'
        "  const venv = m.resolvePython({"
        "    env: {}, root: '/repo', platform: 'linux',"
        "    isFile: (p) => p === '/repo/.venv/bin/python',"
        '  });'
        "  const windows = m.resolvePython({"
        "    env: {}, root: 'C:/repo', platform: 'win32',"
        "    isFile: (p) => p.endsWith('python.exe'),"
        '  });'
        "  const fallback = m.resolvePython({ env: {}, root: '/nowhere', isFile: () => false });"
        '  console.log(JSON.stringify({'
        '    override: override.command,'
        '    overrideSource: override.source,'
        '    venv: venv.command,'
        '    windows: windows.command,'
        '    fallback: fallback.command,'
        '  }));'
        '});'
    )
    result = subprocess.run([NODE, '-e', script], capture_output=True, text=True)

    assert result.returncode == 0, result.stderr
    resolved = json.loads(result.stdout)
    assert resolved['override'] == '/custom/python'
    assert resolved['overrideSource'] == 'PDF_INSPECTOR_PYTHON'
    assert resolved['venv'] == '/repo/.venv/bin/python'
    assert resolved['windows'].endswith('python.exe')
    assert resolved['fallback'] == 'python3'
