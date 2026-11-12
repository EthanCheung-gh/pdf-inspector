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
PAGE_KEYS = {'oldIndex', 'newIndex', 'status', 'oldSize', 'newSize', 'match', 'changes'}
SUMMARY_KEYS = {
    'pagesAdded',
    'pagesRemoved',
    'pagesChanged',
    'pagesReordered',
    'objectsAdded',
    'objectsRemoved',
    'objectsMoved',
    'objectsModified',
    'changesTruncated',
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
        # the same two pages in the opposite order: paired, but reordered
        'swapped_pages': build(
            'swapped_pages.pdf',
            _page(_draw_text('Page Two')),
            _page(_draw_text('Page One')),
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
    'reordered': ('two_pages', 'swapped_pages'),
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

    assert set(data) == {
        'schemaVersion',
        'tool',
        'options',
        'old',
        'new',
        'summary',
        'truncated',
        'pages',
    }
    assert data['schemaVersion'] == 1
    assert data['tool']['name'] == 'pdf-inspector'
    assert re.fullmatch(r'\d+\.\d+\.\d+', data['tool']['version'])
    assert set(data['summary']) == SUMMARY_KEYS
    assert data['truncated'] is False
    assert data['summary']['objectsModified'] >= 1
    assert data['summary']['pagesReordered'] == 0
    assert data['old']['pages'] == 1 and data['new']['pages'] == 1
    assert len(data['old']['sha256']) == 64 and len(data['new']['sha256']) == 64
    assert set(data['options']) == {
        'positionTolerance',
        'textTolerance',
        'ignoreTypes',
        'ignoreFonts',
        'ignoreColors',
        'ignoreImages',
        'ignoreRegions',
    }

    for page in data['pages']:
        assert set(page) == PAGE_KEYS
        assert page['status'] in ('added', 'removed', 'changed', 'unchanged')
        if page['oldIndex'] is None or page['newIndex'] is None:
            assert page['match'] is None
        else:
            assert set(page['match']) == {'score', 'reordered'}
        for change in page['changes']:
            assert set(change) == CHANGE_KEYS
            assert change['kind'] in ('added', 'removed', 'moved', 'modified')


def test_json_reports_aligned_page_pairs_for_reordered_docs(docs):
    data = _json_result(docs, 'reordered')

    assert data['summary']['pagesReordered'] == 1
    assert [
        (page['oldIndex'], page['newIndex'], page['match'])
        for page in data['pages']
        if page['match'] is not None
    ] == [(1, 2, {'score': 1.0, 'reordered': True})]


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
        'ignoreRegions': [],
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
        ('reordered', 'reordered', 1),
        ('reordered', 'none', 0),
        ('same', 'reordered', 0),
        ('changed', 'reordered', 0),
        ('extra', 'reordered', 0),
        ('page_removed', 'reordered', 0),
        ('page_added', 'reordered', 0),
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
    assert cli.failure_reason(result, 'reordered') is None


def test_failure_reason_covers_reordered_pages():
    result = {
        'old': {'pages': 2},
        'new': {'pages': 2},
        'summary': {
            'pagesAdded': 0,
            'pagesRemoved': 0,
            'pagesChanged': 0,
            'pagesReordered': 2,
            'objectsAdded': 0,
            'objectsRemoved': 0,
            'objectsMoved': 0,
            'objectsModified': 0,
        },
        'pages': [
            {
                'oldIndex': 2,
                'newIndex': 1,
                'status': 'unchanged',
                'oldSize': {'width': 612.0, 'height': 792.0},
                'newSize': {'width': 612.0, 'height': 792.0},
                'match': {'score': 1.0, 'reordered': True},
                'changes': [],
            }
        ],
    }

    reason = cli.failure_reason(result, 'reordered')

    assert reason == '2 page pair(s) at a different page number (fail-on reordered)'
    assert '\n' not in reason
    # Reordering alone keeps every other threshold quiet.
    assert cli.failure_reason(result, 'none') is None
    assert cli.failure_reason(result, 'modified') is None


def test_fail_on_reordered_reports_one_line_reason(docs):
    result = run_pair(docs, 'reordered', '--fail-on', 'reordered', '--quiet')

    assert result.returncode == 1
    assert result.stdout == ''
    assert 'fail-on reordered' in result.stderr
    assert result.stderr.strip().count('\n') == 0


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


# --- ignore regions ---------------------------------------------------------


def _region_file(tmp_path: Path, regions: object, name: str = 'regions.json') -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(regions), encoding='utf-8')
    return path


TEXT_REGION = {
    'oldPage': 1,
    'newPage': 1,
    'bbox': {'x0': 90, 'y0': 690, 'x1': 200, 'y1': 720},
}


def test_ignore_regions_file_masks_changes(docs, tmp_path):
    path = _region_file(tmp_path, [TEXT_REGION])

    data = _json_result(docs, 'changed', '--ignore-regions', str(path))

    assert data['options']['ignoreRegions'] == [TEXT_REGION]
    assert data['pages'][0]['changes'] == []
    assert data['pages'][0]['status'] == 'unchanged'
    assert data['summary']['objectsModified'] == 0


def test_ignore_regions_change_the_fail_on_outcome(docs, tmp_path):
    path = _region_file(tmp_path, [TEXT_REGION])

    result = run_pair(docs, 'changed', '--format', 'json', '--ignore-regions', str(path))

    # `--fail-on any` keeps its meaning: masking the only change leaves nothing
    # to fail on.
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['summary']['objectsModified'] == 0

    without_regions = run_pair(docs, 'changed', '--format', 'json')
    assert without_regions.returncode == 1


def test_ignore_region_file_accepts_an_empty_array(docs, tmp_path):
    path = _region_file(tmp_path, [])

    data = _json_result(docs, 'changed', '--ignore-regions', str(path))

    assert data['options']['ignoreRegions'] == []
    assert data['summary']['objectsModified'] >= 1


def test_missing_ignore_regions_file_is_a_cli_error(docs, tmp_path):
    result = run_pair(docs, 'changed', '--ignore-regions', str(tmp_path / 'nope.json'))

    assert result.returncode == 2
    assert 'cannot read ignore regions file' in result.stderr
    assert result.stdout == ''
    assert 'Traceback' not in result.stderr


def test_ignore_regions_file_must_be_a_json_array(docs, tmp_path):
    path = _region_file(tmp_path, {'oldPage': 1})

    result = run_pair(docs, 'changed', '--ignore-regions', str(path))

    assert result.returncode == 2
    assert 'must contain a JSON array' in result.stderr
    assert result.stdout == ''


def test_ignore_regions_file_must_be_valid_json(docs, tmp_path):
    path = tmp_path / 'broken.json'
    path.write_text('[{"oldPage": 1,', encoding='utf-8')

    result = run_pair(docs, 'changed', '--ignore-regions', str(path))

    assert result.returncode == 2
    assert 'not valid JSON' in result.stderr


def test_invalid_ignore_region_is_reported_clearly(docs, tmp_path):
    path = _region_file(
        tmp_path,
        [
            {
                'oldPage': 1,
                'newPage': 1,
                'bbox': {'x0': 200, 'y0': 0, 'x1': 100, 'y1': 10},
            }
        ],
    )

    result = run_pair(docs, 'changed', '--ignore-regions', str(path))

    assert result.returncode == 2
    assert 'ignore_regions[0]' in result.stderr
    assert 'ordered' in result.stderr
    assert 'Traceback' not in result.stderr


def test_fail_on_reordered_is_preserved(docs):
    result = run_pair(docs, 'reordered', '--fail-on', 'reordered')

    assert result.returncode == 1
    assert 'fail-on reordered' in result.stderr
    assert run_pair(docs, 'same', '--fail-on', 'reordered').returncode == 0


def test_help_documents_reordered_and_ignore_regions():
    result = run_cli('diff', '--help')

    assert result.returncode == 0
    assert '--fail-on' in result.stdout
    assert 'reordered' in result.stdout
    assert '--ignore-regions' in result.stdout
    assert 'JSON array' in result.stdout
    assert '--fail-on reordered' in result.stdout


def test_html_report_reports_reordered_page_alignment(docs):
    result = run_pair(docs, 'reordered', '--format', 'html', '--fail-on', 'none')

    assert result.returncode == 0, result.stderr
    assert '<table class="pages">' in result.stdout
    assert 'Page alignment' in result.stdout
    assert 'Pages reordered' in result.stdout
    assert 'reordered</span>' in result.stdout


def test_html_report_summarises_ignored_regions(docs, tmp_path):
    path = _region_file(tmp_path, [TEXT_REGION])

    masked = run_pair(
        docs, 'changed', '--format', 'html', '--ignore-regions', str(path), '--fail-on', 'none'
    )
    assert masked.returncode == 0, masked.stderr
    assert '<table class="regions">' in masked.stdout
    assert '1 region(s) masked' in masked.stdout
    assert '(90, 690) - (200, 720)' in masked.stdout
    assert 'No object changes.' in masked.stdout
    assert '<code>Alpha</code>' not in masked.stdout

    unmasked = run_pair(docs, 'changed', '--format', 'html', '--fail-on', 'none')
    assert unmasked.returncode == 0, unmasked.stderr
    assert '0 region(s) masked' in unmasked.stdout
    assert 'No ignore regions.' in unmasked.stdout
    assert '<code>Alpha</code>' in unmasked.stdout


def test_summary_reports_ignored_regions(docs, tmp_path):
    path = _region_file(tmp_path, [TEXT_REGION])

    result = run_pair(docs, 'changed', '--ignore-regions', str(path), '--fail-on', 'none')

    assert result.returncode == 0, result.stderr
    assert 'ignored regions: 1' in result.stdout
    assert '  - old page 1 / new page 1: (90, 690) - (200, 720)' in result.stdout
    assert 'changes: none - documents match' in result.stdout
    assert 'ignored regions: 0' in run_pair(docs, 'changed', '--fail-on', 'none').stdout



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


# --- security command -------------------------------------------------------

SECURITY_SAMPLE = REPO_ROOT / 'web-samples' / 'security-sample.pdf'
SECURITY_GENERATOR = REPO_ROOT / 'scripts' / 'generate-security-sample.py'


@pytest.fixture(scope='module', autouse=True)
def _generate_security_sample():
    """Regenerate the deterministic sample if a checkout lacks the fixture."""
    if not SECURITY_SAMPLE.exists():
        subprocess.run(
            [sys.executable, str(SECURITY_GENERATOR)],
            check=True,
            cwd=str(REPO_ROOT),
        )
    return SECURITY_SAMPLE


SECURITY_REPORT_KEYS = {
    'schemaVersion',
    'tool',
    'document',
    'attachments',
    'javascript',
    'actions',
    'signatures',
    'encryption',
    'findings',
    'summary',
}
SECURITY_DOCUMENT_KEYS = {
    'pages',
    'version',
    'encrypted',
    'xfa',
    'hasMetadata',
    'outputIntents',
}
SECURITY_SUMMARY_KEYS = {'total', 'errors', 'warnings', 'info'}


def run_security(*args: str) -> subprocess.CompletedProcess:
    return run_cli('security', str(SECURITY_SAMPLE), *args)


def security_json(*args: str) -> dict:
    result = run_security('--format', 'json', *args)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_security_json_matches_the_security_report_contract():
    data = security_json()

    assert set(data) == SECURITY_REPORT_KEYS
    assert data['schemaVersion'] == 1
    assert data['tool']['name'] == 'pdf-inspector'
    assert re.fullmatch(r'\d+\.\d+\.\d+', data['tool']['version'])
    assert set(data['document']) == SECURITY_DOCUMENT_KEYS
    assert data['document']['pages'] == 1
    assert data['document']['xfa'] is True
    assert data['encryption'] is None

    assert [item['name'] for item in data['attachments']] == ['notes.txt']
    assert data['attachments'][0]['mimeType'] == 'text/plain'
    assert len(data['javascript']) == 2
    assert {'JavaScript', 'URI'} <= {item['subtype'] for item in data['actions']}
    assert [item['fieldName'] for item in data['signatures']] == ['Approval']
    assert data['signatures'][0]['verified'] is False

    assert set(data['summary']) == SECURITY_SUMMARY_KEYS
    assert data['summary']['total'] == len(data['findings'])
    assert data['summary']['warnings'] >= 2
    for finding in data['findings']:
        assert finding['category'] == 'security'
        assert finding['severity'] in ('error', 'warning', 'info')


def test_security_json_stdout_is_pure_json_and_deterministic():
    first = run_security('--format', 'json')
    second = run_security('--format', 'json')

    assert first.returncode == second.returncode == 0
    assert first.stderr == ''
    assert first.stdout.lstrip().startswith('{')
    json.loads(first.stdout)
    assert first.stdout == second.stdout


def test_security_json_has_no_absolute_paths_or_timestamps():
    result = run_security('--format', 'json')

    assert str(SECURITY_SAMPLE) not in result.stdout
    assert str(REPO_ROOT) not in result.stdout
    assert '.pdf' not in result.stdout
    assert not re.search(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', result.stdout)


def test_security_summary_is_the_default_and_reports_counts():
    result = run_security()

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.startswith('pdf-inspector ')
    assert ' - PDF security' in result.stdout
    assert (
        'document: 1 page(s), version 1.7, encrypted: no, XFA: yes'
        in result.stdout
    )
    assert (
        'resources: 1 attachment, 2 JavaScript, 3 actions, 1 signature field'
        in result.stdout
    )
    assert 'encryption: none' in result.stdout
    assert 'summary: 0 errors, 3 warnings, 2 info (5 total)' in result.stdout
    assert '[warning] security: Document contains JavaScript' in result.stdout


def test_security_summary_shows_the_file_name_but_not_its_path():
    result = run_security()

    assert f'file: {SECURITY_SAMPLE.name}' in result.stdout
    assert str(SECURITY_SAMPLE) not in result.stdout
    assert str(SECURITY_SAMPLE.parent) not in result.stdout


def test_security_html_on_stdout_is_standalone():
    result = run_security('--format', 'html')

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.startswith('<!DOCTYPE html>')
    assert '<title>PDF security report' in result.stdout
    assert '<style>' in result.stdout
    assert '<script' not in result.stdout
    assert 'summary: 0 errors' not in result.stdout


def test_security_output_file_equals_the_stdout_payload(tmp_path):
    output = tmp_path / 'security.json'
    result = run_security('--format', 'json', '--output', str(output))

    assert result.returncode == 0
    assert result.stderr == ''
    assert not result.stdout.lstrip().startswith('{')
    assert 'summary:' in result.stdout

    written = json.loads(output.read_text(encoding='utf-8'))
    assert written == security_json()


def test_security_quiet_suppresses_the_human_summary_only():
    quiet_summary = run_security('--quiet')
    assert quiet_summary.returncode == 0
    assert quiet_summary.stdout == ''
    assert quiet_summary.stderr == ''

    quiet_json = run_security('--format', 'json', '--quiet')
    assert quiet_json.returncode == 0
    assert json.loads(quiet_json.stdout)['attachments'][0]['name'] == 'notes.txt'


def test_security_quiet_with_output_writes_the_file_without_stdout(tmp_path):
    output = tmp_path / 'security.html'
    result = run_security(
        '--format', 'html', '--output', str(output), '--quiet'
    )

    assert result.returncode == 0
    assert result.stdout == ''
    assert output.read_text(encoding='utf-8').startswith('<!DOCTYPE html>')


@pytest.mark.parametrize(
    'key, fail_on, expected',
    [
        ('security', 'none', 0),
        ('security', 'error', 0),
        ('security', 'warning', 1),
        ('clean', 'none', 0),
        ('clean', 'error', 0),
        ('clean', 'warning', 0),
    ],
)
def test_security_fail_on_thresholds(docs, key, fail_on, expected):
    path = str(SECURITY_SAMPLE) if key == 'security' else docs['same_a']
    result = run_cli('security', path, '--fail-on', fail_on, '--quiet')

    assert result.returncode == expected, result.stderr
    if expected:
        assert 'fail-on warning' in result.stderr
        assert '3 warning(s)' in result.stderr
    else:
        assert result.stderr == ''


def test_security_fail_on_still_prints_the_summary():
    result = run_security('--fail-on', 'warning')

    assert result.returncode == 1
    assert 'summary: 0 errors, 3 warnings' in result.stdout
    assert 'pdf-inspector: ' in result.stderr


def test_security_fail_on_writes_the_report_before_failing(tmp_path):
    output = tmp_path / 'security.json'
    result = run_security(
        '--format',
        'json',
        '--output',
        str(output),
        '--fail-on',
        'warning',
    )

    assert result.returncode == 1
    written = json.loads(output.read_text(encoding='utf-8'))
    assert written['summary']['warnings'] >= 2


def test_security_failure_reason_helper():
    clean = {'summary': {'errors': 0, 'warnings': 0}}
    warned = {'summary': {'errors': 0, 'warnings': 2}}
    failed = {'summary': {'errors': 1, 'warnings': 0}}

    assert cli.security_failure_reason(clean, 'none') is None
    assert cli.security_failure_reason(clean, 'error') is None
    assert cli.security_failure_reason(clean, 'warning') is None

    assert cli.security_failure_reason(warned, 'none') is None
    assert cli.security_failure_reason(warned, 'error') is None
    assert '2 warning(s)' in cli.security_failure_reason(warned, 'warning')

    assert 'fail-on error' in cli.security_failure_reason(failed, 'error')
    assert 'fail-on warning' in cli.security_failure_reason(failed, 'warning')

    with pytest.raises(ValueError):
        cli.security_failure_reason(clean, 'sometimes')


def test_security_report_error_is_a_one_line_exit_2(monkeypatch, capsys, docs):
    def explode(extractor):
        raise ValueError('security report failed')

    monkeypatch.setattr(cli, 'security_report', explode)

    code = cli.main(['security', docs['same_a'], '--quiet'])

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert 'security report failed' in captured.err
    assert 'Traceback' not in captured.err


def test_security_unknown_format_is_a_usage_error():
    result = run_security('--format', 'yaml')

    assert result.returncode == 2
    assert 'invalid choice' in result.stderr.lower()
    assert result.stdout == ''


def test_security_unknown_fail_on_is_a_usage_error():
    result = run_security('--fail-on', 'sometimes')

    assert result.returncode == 2
    assert result.stdout == ''


def test_security_missing_file_argument_is_a_usage_error():
    result = run_cli('security')

    assert result.returncode == 2
    assert 'usage' in result.stderr.lower()
    assert result.stdout == ''


def test_security_missing_file_is_a_one_line_error():
    result = run_cli('security', '/definitely/not/here.pdf')

    assert result.returncode == 2
    assert result.stdout == ''
    assert 'not found' in result.stderr
    assert 'Traceback' not in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_security_directory_input_is_rejected(tmp_path):
    result = run_cli('security', str(tmp_path))

    assert result.returncode == 2
    assert 'not a file' in result.stderr


def test_security_non_pdf_input_is_rejected(docs):
    result = run_cli('security', docs['not_pdf'])

    assert result.returncode == 2
    assert 'not a PDF' in result.stderr
    assert result.stdout == ''
    assert result.stderr.strip().count('\n') == 0


def test_security_http_url_input_is_rejected_without_network():
    result = run_cli('security', 'https://example.com/sample.pdf')

    assert result.returncode == 2
    assert 'local file path' in result.stderr
    assert 'URL' in result.stderr
    assert result.stdout == ''


def test_security_malformed_pdf_is_a_report_error(docs):
    result = run_cli('security', docs['broken'])

    assert result.returncode == 2
    assert 'Traceback' not in result.stderr
    assert result.stderr.strip().count('\n') == 0
    assert result.stdout == ''


def test_security_output_to_missing_directory_fails(tmp_path):
    missing = tmp_path / 'missing-dir' / 'security.json'
    result = run_security('--format', 'json', '--output', str(missing))

    assert result.returncode == 2
    assert 'output directory does not exist' in result.stderr


def test_security_output_to_directory_path_fails(tmp_path):
    result = run_security('--format', 'json', '--output', str(tmp_path))

    assert result.returncode == 2
    assert 'directory' in result.stderr


def test_security_output_cannot_overwrite_the_input_pdf(tmp_path):
    target = tmp_path / 'input.pdf'
    original = SECURITY_SAMPLE.read_bytes()
    target.write_bytes(original)

    result = run_cli(
        'security',
        str(target),
        '--format',
        'json',
        '--output',
        str(target),
    )

    assert result.returncode == 2
    assert 'must not overwrite an input PDF' in result.stderr
    assert target.read_bytes() == original


def test_security_parser_defaults():
    args = cli.build_parser().parse_args(['security', 'sample.pdf'])

    assert args.command == 'security'
    assert args.file == 'sample.pdf'
    assert args.format == 'summary'
    assert args.output is None
    assert args.fail_on == 'none'
    assert args.quiet is False


# --- accessibility command --------------------------------------------------

ACCESSIBILITY_VALID = REPO_ROOT / 'web-samples' / 'accessibility-valid.pdf'
ACCESSIBILITY_BROKEN = REPO_ROOT / 'web-samples' / 'accessibility-broken.pdf'
ACCESSIBILITY_GENERATOR = REPO_ROOT / 'scripts' / 'generate-accessibility-samples.py'


@pytest.fixture(scope='module', autouse=True)
def _generate_accessibility_samples():
    """Regenerate the deterministic samples if a checkout lacks the fixtures."""
    if not (ACCESSIBILITY_VALID.exists() and ACCESSIBILITY_BROKEN.exists()):
        subprocess.run(
            [sys.executable, str(ACCESSIBILITY_GENERATOR)],
            check=True,
            cwd=str(REPO_ROOT),
        )
    return ACCESSIBILITY_VALID, ACCESSIBILITY_BROKEN


ACCESSIBILITY_REPORT_KEYS = {
    'schemaVersion',
    'tool',
    'document',
    'structure',
    'findings',
    'summary',
}
ACCESSIBILITY_DOCUMENT_KEYS = {
    'pages',
    'version',
    'encrypted',
    'tagged',
    'hasStructTreeRoot',
    'hasParentTree',
    'language',
    'title',
    'roleMap',
    'truncated',
    'skipped',
}
ACCESSIBILITY_NODE_KEYS = {
    'id',
    'kind',
    'role',
    'rawRole',
    'title',
    'alt',
    'actualText',
    'lang',
    'page',
    'mcid',
    'objectNumber',
    'attributes',
    'children',
    'truncated',
}
ACCESSIBILITY_SUMMARY_KEYS = {'total', 'errors', 'warnings', 'info'}

# Findings the broken sample is built to trigger (see the generator).
BROKEN_FINDING_TITLES = {
    'Structure tree has no ParentTree',
    'Figure has no alternative text',
    'Heading levels are skipped',
    'List has no list items',
    'Table has no rows',
}


def run_accessibility(path=ACCESSIBILITY_BROKEN, *args: str) -> subprocess.CompletedProcess:
    return run_cli('accessibility', str(path), *args)


def accessibility_json(path=ACCESSIBILITY_BROKEN, *args: str) -> dict:
    result = run_accessibility(path, '--format', 'json', *args)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_accessibility_json_matches_the_accessibility_report_contract():
    data = accessibility_json()

    assert set(data) == ACCESSIBILITY_REPORT_KEYS
    assert data['schemaVersion'] == 1
    assert data['tool']['name'] == 'pdf-inspector'
    assert re.fullmatch(r'\d+\.\d+\.\d+', data['tool']['version'])

    document = data['document']
    assert set(document) == ACCESSIBILITY_DOCUMENT_KEYS
    assert document['pages'] == 1
    assert document['tagged'] is True
    assert document['hasStructTreeRoot'] is True
    assert document['hasParentTree'] is False
    assert document['language'] == 'en-US'

    assert isinstance(data['structure'], list) and data['structure']
    stack = list(data['structure'])
    seen: set[str] = set()
    while stack:
        node = stack.pop()
        assert set(node) == ACCESSIBILITY_NODE_KEYS, set(node)
        assert node['kind'] in ('element', 'mcid', 'object')
        assert isinstance(node['id'], str) and node['id']
        assert node['id'] not in seen, node['id']
        seen.add(node['id'])
        stack.extend(node['children'])

    summary = data['summary']
    assert set(summary) == ACCESSIBILITY_SUMMARY_KEYS
    assert summary['total'] == len(data['findings'])
    assert summary['errors'] == 0
    assert summary['warnings'] == 5
    assert summary['total'] == summary['errors'] + summary['warnings'] + summary['info']
    assert {finding['title'] for finding in data['findings']} == BROKEN_FINDING_TITLES
    for finding in data['findings']:
        assert finding['category'] == 'structure'
        assert finding['severity'] in ('error', 'warning', 'info')
        assert finding['detail']
        assert finding['page'] is None or isinstance(finding['page'], int)


def test_accessibility_json_reports_no_findings_for_the_valid_sample():
    data = accessibility_json(ACCESSIBILITY_VALID)

    assert data['document']['hasParentTree'] is True
    assert data['findings'] == []
    assert data['summary'] == {'total': 0, 'errors': 0, 'warnings': 0, 'info': 0}
    roles = {
        node['role']
        for node in data['structure'][0]['children']
        if node['kind'] == 'element'
    }
    assert {'H1', 'P', 'Figure', 'Table'} <= roles


def test_accessibility_json_stdout_is_pure_json_and_deterministic():
    first = run_accessibility(ACCESSIBILITY_BROKEN, '--format', 'json')
    second = run_accessibility(ACCESSIBILITY_BROKEN, '--format', 'json')

    assert first.returncode == second.returncode == 0
    assert first.stderr == ''
    assert first.stdout.lstrip().startswith('{')
    json.loads(first.stdout)
    assert first.stdout == second.stdout


def test_accessibility_json_has_no_absolute_paths_or_timestamps():
    result = run_accessibility('--format', 'json')

    assert str(ACCESSIBILITY_BROKEN) not in result.stdout
    assert str(REPO_ROOT) not in result.stdout
    assert not re.search(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', result.stdout)


def test_accessibility_summary_is_the_default_and_reports_facts_and_findings():
    result = run_accessibility()

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.startswith('pdf-inspector ')
    assert ' - PDF accessibility' in result.stdout
    assert (
        'document: 1 page(s), version 1.7, encrypted: no, tagged: yes, '
        'language: en-US' in result.stdout
    )
    assert 'structure: elements 8, figures 1, tables 1, lists 1, headings 2' in result.stdout
    assert 'tree: StructTreeRoot yes, ParentTree no, truncated no, skipped 0' in result.stdout
    assert 'summary: 0 errors, 5 warnings, 0 info (5 total)' in result.stdout
    assert '[warning] structure: Structure tree has no ParentTree' in result.stdout
    assert '[warning] structure, page 1: Figure has no alternative text' in result.stdout


def test_accessibility_summary_reports_a_clean_document():
    result = run_accessibility(ACCESSIBILITY_VALID)

    assert result.returncode == 0
    assert result.stderr == ''
    assert 'summary: 0 errors, 0 warnings, 0 info (0 total)' in result.stdout
    assert 'findings: none - no accessibility findings' in result.stdout
    assert 'tree: StructTreeRoot yes, ParentTree yes' in result.stdout


def test_accessibility_summary_shows_the_file_name_but_not_its_path():
    result = run_accessibility()

    assert f'file: {ACCESSIBILITY_BROKEN.name}' in result.stdout
    assert str(ACCESSIBILITY_BROKEN) not in result.stdout
    assert str(ACCESSIBILITY_BROKEN.parent) not in result.stdout


def test_accessibility_html_on_stdout_is_standalone():
    result = run_accessibility(ACCESSIBILITY_BROKEN, '--format', 'html')

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.startswith('<!DOCTYPE html>')
    assert '<title>PDF accessibility report' in result.stdout
    assert '<style>' in result.stdout
    assert '<script' not in result.stdout
    assert '<link' not in result.stdout
    assert 'summary:' not in result.stdout


def test_accessibility_output_file_equals_the_stdout_payload(tmp_path):
    output = tmp_path / 'accessibility.json'
    result = run_accessibility(
        ACCESSIBILITY_BROKEN, '--format', 'json', '--output', str(output)
    )

    assert result.returncode == 0
    assert result.stderr == ''
    assert not result.stdout.lstrip().startswith('{')
    assert 'summary:' in result.stdout

    written = json.loads(output.read_text(encoding='utf-8'))
    assert written == accessibility_json()


def test_accessibility_output_html_file_is_standalone(tmp_path):
    output = tmp_path / 'accessibility.html'
    result = run_accessibility(
        ACCESSIBILITY_BROKEN, '--format', 'html', '--output', str(output)
    )

    assert result.returncode == 0
    assert 'summary:' in result.stdout
    content = output.read_text(encoding='utf-8')
    assert content.startswith('<!DOCTYPE html>')
    assert 'PDF accessibility report' in content
    assert '<script' not in content


def test_accessibility_quiet_suppresses_the_human_summary_only():
    quiet_summary = run_accessibility(ACCESSIBILITY_BROKEN, '--quiet')
    assert quiet_summary.returncode == 0
    assert quiet_summary.stdout == ''
    assert quiet_summary.stderr == ''

    quiet_json = run_accessibility(ACCESSIBILITY_BROKEN, '--format', 'json', '--quiet')
    assert quiet_json.returncode == 0
    assert json.loads(quiet_json.stdout)['summary']['warnings'] == 5


def test_accessibility_quiet_with_output_writes_the_file_without_stdout(tmp_path):
    output = tmp_path / 'accessibility.html'
    result = run_accessibility(
        ACCESSIBILITY_BROKEN, '--format', 'html', '--output', str(output), '--quiet'
    )

    assert result.returncode == 0
    assert result.stdout == ''
    assert output.read_text(encoding='utf-8').startswith('<!DOCTYPE html>')


@pytest.mark.parametrize(
    'path, fail_on, expected',
    [
        (ACCESSIBILITY_BROKEN, 'none', 0),
        (ACCESSIBILITY_BROKEN, 'error', 0),
        (ACCESSIBILITY_BROKEN, 'warning', 1),
        (ACCESSIBILITY_VALID, 'none', 0),
        (ACCESSIBILITY_VALID, 'error', 0),
        (ACCESSIBILITY_VALID, 'warning', 0),
    ],
)
def test_accessibility_fail_on_thresholds(path, fail_on, expected):
    result = run_accessibility(path, '--fail-on', fail_on, '--quiet')

    assert result.returncode == expected, result.stderr
    if expected:
        assert 'fail-on warning' in result.stderr
        assert '5 warning(s)' in result.stderr
    else:
        assert result.stderr == ''


def test_accessibility_fail_on_still_prints_the_summary():
    result = run_accessibility(ACCESSIBILITY_BROKEN, '--fail-on', 'warning')

    assert result.returncode == 1
    assert 'summary: 0 errors, 5 warnings' in result.stdout
    assert 'pdf-inspector: ' in result.stderr


def test_accessibility_fail_on_writes_the_report_before_failing(tmp_path):
    output = tmp_path / 'accessibility.json'
    result = run_accessibility(
        ACCESSIBILITY_BROKEN,
        '--format',
        'json',
        '--output',
        str(output),
        '--fail-on',
        'warning',
    )

    assert result.returncode == 1
    written = json.loads(output.read_text(encoding='utf-8'))
    assert written['summary']['warnings'] == 5


def test_accessibility_failure_reason_helper():
    clean = {'summary': {'errors': 0, 'warnings': 0}}
    warned = {'summary': {'errors': 0, 'warnings': 2}}
    failed = {'summary': {'errors': 1, 'warnings': 0}}

    assert cli.accessibility_failure_reason(clean, 'none') is None
    assert cli.accessibility_failure_reason(clean, 'error') is None
    assert cli.accessibility_failure_reason(clean, 'warning') is None

    assert cli.accessibility_failure_reason(warned, 'none') is None
    assert cli.accessibility_failure_reason(warned, 'error') is None
    assert '2 warning(s)' in cli.accessibility_failure_reason(warned, 'warning')

    assert 'fail-on error' in cli.accessibility_failure_reason(failed, 'error')
    assert 'fail-on warning' in cli.accessibility_failure_reason(failed, 'warning')

    with pytest.raises(ValueError):
        cli.accessibility_failure_reason(clean, 'sometimes')


def test_accessibility_report_error_is_a_one_line_exit_2(monkeypatch, capsys, docs):
    def explode(extractor):
        raise ValueError('accessibility report failed')

    monkeypatch.setattr(cli, 'accessibility_report', explode)

    code = cli.main(['accessibility', docs['same_a'], '--quiet'])

    captured = capsys.readouterr()
    assert code == 2
    assert captured.out == ''
    assert 'accessibility report failed' in captured.err
    assert 'Traceback' not in captured.err


def test_accessibility_parser_defaults():
    args = cli.build_parser().parse_args(['accessibility', 'sample.pdf'])

    assert args.command == 'accessibility'
    assert args.file == 'sample.pdf'
    assert args.format == 'summary'
    assert args.output is None
    assert args.fail_on == 'none'
    assert args.quiet is False


def test_accessibility_unknown_format_is_a_usage_error():
    result = run_accessibility(ACCESSIBILITY_BROKEN, '--format', 'yaml')

    assert result.returncode == 2
    assert 'invalid choice' in result.stderr.lower()
    assert result.stdout == ''


def test_accessibility_unknown_fail_on_is_a_usage_error():
    result = run_accessibility(ACCESSIBILITY_BROKEN, '--fail-on', 'sometimes')

    assert result.returncode == 2
    assert result.stdout == ''


def test_accessibility_missing_file_argument_is_a_usage_error():
    result = run_cli('accessibility')

    assert result.returncode == 2
    assert 'usage' in result.stderr.lower()
    assert result.stdout == ''


def test_accessibility_missing_file_is_a_one_line_error():
    result = run_cli('accessibility', '/definitely/not/here.pdf')

    assert result.returncode == 2
    assert result.stdout == ''
    assert 'not found' in result.stderr
    assert 'Traceback' not in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_accessibility_directory_input_is_rejected(tmp_path):
    result = run_cli('accessibility', str(tmp_path))

    assert result.returncode == 2
    assert 'not a file' in result.stderr


def test_accessibility_non_pdf_input_is_rejected(docs):
    result = run_cli('accessibility', docs['not_pdf'])

    assert result.returncode == 2
    assert 'not a PDF' in result.stderr
    assert result.stdout == ''
    assert result.stderr.strip().count('\n') == 0


def test_accessibility_http_url_input_is_rejected_without_network():
    result = run_cli('accessibility', 'https://example.com/sample.pdf')

    assert result.returncode == 2
    assert 'local file path' in result.stderr
    assert 'URL' in result.stderr
    assert result.stdout == ''


def test_accessibility_malformed_pdf_is_a_report_error(docs):
    result = run_cli('accessibility', docs['broken'])

    assert result.returncode == 2
    assert 'Traceback' not in result.stderr
    assert result.stderr.strip().count('\n') == 0
    assert result.stdout == ''


def test_accessibility_output_to_missing_directory_fails(tmp_path):
    missing = tmp_path / 'missing-dir' / 'accessibility.json'
    result = run_accessibility(
        ACCESSIBILITY_VALID, '--format', 'json', '--output', str(missing)
    )

    assert result.returncode == 2
    assert 'output directory does not exist' in result.stderr


def test_accessibility_output_to_directory_path_fails(tmp_path):
    result = run_accessibility(
        ACCESSIBILITY_VALID, '--format', 'json', '--output', str(tmp_path)
    )

    assert result.returncode == 2
    assert 'directory' in result.stderr


def test_accessibility_output_cannot_overwrite_the_input_pdf(tmp_path):
    target = tmp_path / 'input.pdf'
    original = ACCESSIBILITY_VALID.read_bytes()
    target.write_bytes(original)

    result = run_cli(
        'accessibility',
        str(target),
        '--format',
        'json',
        '--output',
        str(target),
    )

    assert result.returncode == 2
    assert 'must not overwrite an input PDF' in result.stderr
    assert target.read_bytes() == original


def test_accessibility_help_documents_formats_and_exit_codes():
    result = run_cli('accessibility', '--help')

    assert result.returncode == 0
    assert '--format' in result.stdout
    assert '--output' in result.stdout
    assert '--fail-on' in result.stdout
    assert 'exit codes' in result.stdout


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
def test_node_wrapper_forwards_security_arguments_and_exit_code():
    result = subprocess.run(
        [
            NODE,
            str(WRAPPER),
            'security',
            str(SECURITY_SAMPLE),
            '--format',
            'json',
            '--quiet',
        ],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert data['attachments'][0]['name'] == 'notes.txt'
    assert data['document']['xfa'] is True

    failing = subprocess.run(
        [
            NODE,
            str(WRAPPER),
            'security',
            str(SECURITY_SAMPLE),
            '--fail-on',
            'warning',
            '--quiet',
        ],
        capture_output=True,
        text=True,
    )
    assert failing.returncode == 1
    assert 'fail-on warning' in failing.stderr


@skip_without_node
def test_node_wrapper_forwards_accessibility_arguments_and_exit_code():
    result = subprocess.run(
        [
            NODE,
            str(WRAPPER),
            'accessibility',
            str(ACCESSIBILITY_BROKEN),
            '--format',
            'json',
            '--quiet',
        ],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert data['summary']['warnings'] == 5
    assert data['document']['hasParentTree'] is False

    failing = subprocess.run(
        [
            NODE,
            str(WRAPPER),
            'accessibility',
            str(ACCESSIBILITY_BROKEN),
            '--fail-on',
            'warning',
            '--quiet',
        ],
        capture_output=True,
        text=True,
    )
    assert failing.returncode == 1
    assert 'fail-on warning' in failing.stderr


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
