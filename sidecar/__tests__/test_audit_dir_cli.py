"""``pdf-inspector audit-dir`` CLI: discovery, formats, exit codes and safety.

The tests work on real trees under ``tmp_path`` built from the two committed
accessibility samples, so the aggregate counts are the engine's own:
``accessibility-valid.pdf`` is clean, ``accessibility-broken.pdf`` has five
warnings.  A hand-written ``%PDF-1.4`` stub stands in for a damaged file, which
is what makes "one bad file does not abort the batch" observable end to end.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI = REPO_ROOT / 'sidecar' / 'cli.py'
SAMPLES = REPO_ROOT / 'web-samples'

# Both samples are committed (see .gitignore), so these tests also run in CI
# before `scripts/generate-web-samples.py` creates the ignored samples.
VALID_SAMPLE = SAMPLES / 'accessibility-valid.pdf'
WARNINGS_SAMPLE = SAMPLES / 'accessibility-broken.pdf'

# A file that promises a document body and never delivers one.
BROKEN_PDF = b'%PDF-1.4\nthis header promises a document body that never arrives\n'

BATCH_KEYS = ['schemaVersion', 'tool', 'root', 'summary', 'files']
SUMMARY_KEYS = [
    'files',
    'audited',
    'failed',
    'findings',
    'errors',
    'warnings',
    'info',
]

# A timestamp anywhere in the payload would break byte-for-byte determinism.
TIMESTAMP = re.compile(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}')

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cli  # noqa: E402


# --- fixtures ---------------------------------------------------------------


def _root(tmp_path: Path, name: str = 'docs') -> Path:
    root = tmp_path / name
    root.mkdir(parents=True)
    return root


def _valid(root: Path, name: str = 'a.pdf') -> Path:
    """Copy the clean sample to ``root/name``, creating parent directories."""
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(VALID_SAMPLE, path)
    return path


def _warnings(root: Path, name: str = 'warned.pdf') -> Path:
    """Copy the sample with five warnings to ``root/name``."""
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(WARNINGS_SAMPLE, path)
    return path


def _broken(root: Path, name: str = 'broken.pdf') -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(BROKEN_PDF)
    return path


def _non_utf8_pdf(root: Path) -> Path:
    """A valid PDF under a file name that is not valid UTF-8, or skip.

    POSIX file names are bytes: ``\\xff`` alone is not UTF-8, so the name
    decodes into the surrogate ``'bad\\udcff.pdf'``.  Platforms that cannot
    represent (or silently re-encode) such a name cannot exercise the rule.
    """
    path = root / os.fsdecode(b'bad\xff.pdf')
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copyfile(VALID_SAMPLE, path)
    except (OSError, UnicodeError):  # pragma: no cover - platform dependent
        pytest.skip('platform cannot create a non-UTF-8 file name')
    if os.fsencode(path.name) != b'bad\xff.pdf':  # pragma: no cover
        pytest.skip('platform re-encoded the non-UTF-8 file name')
    return path


def run_cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def run_dir(root: Path, *args: str) -> subprocess.CompletedProcess:
    return run_cli('audit-dir', str(root), *args)


def dir_json(root: Path, *args: str) -> dict:
    result = run_dir(root, '--format', 'json', *args)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _one_line_error(result: subprocess.CompletedProcess, fragment: str) -> None:
    """A CLI user error: exit 2, empty stdout, exactly one diagnostic line."""
    assert result.returncode == 2, result.stdout
    assert result.stdout == ''
    assert result.stderr.startswith('pdf-inspector: error: ')
    assert fragment in result.stderr
    assert 'Traceback' not in result.stderr
    assert result.stderr.strip().count('\n') == 0


def _batch(entries, *, root_name: str = 'docs') -> dict:
    """A hand-written ``BatchReport`` for the renderer's edge cases."""
    audited = [entry for entry in entries if entry['status'] == 'ok']
    failed = len(entries) - len(audited)
    errors = sum(entry['summary']['errors'] for entry in audited)
    warnings = sum(entry['summary']['warnings'] for entry in audited)
    info = sum(entry['summary']['info'] for entry in audited)
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': '0.3.3'},
        'root': {'name': root_name, 'files': len(entries), 'bytes': 0},
        'summary': {
            'files': len(entries),
            'audited': len(audited),
            'failed': failed,
            'findings': errors + warnings + info,
            # The engine adds failed files to ``errors`` only.
            'errors': errors + failed,
            'warnings': warnings,
            'info': info,
        },
        'files': entries,
    }


def _ok_entry(path: str, *, errors: int = 0, warnings: int = 0) -> dict:
    return {
        'path': path,
        'status': 'ok',
        'bytes': 100,
        'document': {},
        'summary': {
            'total': errors + warnings,
            'errors': errors,
            'warnings': warnings,
            'info': 0,
        },
        'findings': [],
    }


def _error_entry(path: str, error: str = 'Cannot open PDF') -> dict:
    return {'path': path, 'status': 'error', 'bytes': 10, 'error': error}


# --- root validation --------------------------------------------------------


def test_url_root_is_rejected():
    result = run_cli('audit-dir', 'https://example.com/docs')

    _one_line_error(result, 'local directory path, not a URL')
    assert 'URL' in result.stderr


@pytest.mark.parametrize('root', ['file:///tmp/docs', 'ftp://example.com/docs'])
def test_other_url_schemes_are_rejected(root):
    _one_line_error(run_cli('audit-dir', root), 'local directory path, not a URL')


def test_missing_root_is_rejected(tmp_path):
    _one_line_error(run_dir(tmp_path / 'missing'), 'directory not found')


def test_file_root_is_rejected(tmp_path):
    root = _root(tmp_path)
    target = _valid(root)

    _one_line_error(run_dir(target), 'path is not a directory')


def test_empty_root_argument_is_rejected():
    _one_line_error(run_cli('audit-dir', ''), 'must not be empty')


# --- summary output ---------------------------------------------------------


def test_empty_directory_summary_and_exit_zero(tmp_path):
    result = run_dir(_root(tmp_path, 'empty'))

    assert result.returncode == 0
    assert result.stderr == ''
    lines = result.stdout.splitlines()
    assert lines[0].startswith('pdf-inspector ')
    assert lines[0].endswith(' - PDF audit directory')
    assert 'root: empty' in lines
    assert 'files: 0 (0 audited, 0 failed)' in lines
    assert 'findings: 0 errors, 0 warnings, 0 info (0 total)' in lines
    assert lines[-1] == 'no PDF files found'


def test_two_valid_pdfs_are_counted_and_listed(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _valid(root, 'reports/b.pdf')

    result = run_dir(root)

    assert result.returncode == 0
    assert result.stderr.splitlines() == [
        'audit-dir: [1/2] a.pdf',
        'audit-dir: [2/2] reports/b.pdf',
    ]
    assert f'root: {root.name}' in result.stdout
    assert 'files: 2 (2 audited, 0 failed)' in result.stdout
    assert 'findings: 0 errors, 0 warnings, 0 info (0 total)' in result.stdout
    assert '  ok    a.pdf: 0 errors, 0 warnings' in result.stdout
    assert '  ok    reports/b.pdf: 0 errors, 0 warnings' in result.stdout
    assert str(tmp_path) not in result.stdout


def test_a_broken_file_is_reported_and_the_batch_continues(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _broken(root, 'broken.pdf')

    result = run_dir(root)

    assert result.returncode == 0, result.stderr
    assert 'files: 2 (1 audited, 1 failed)' in result.stdout
    # The failed file is one error in the aggregate.
    assert 'findings: 1 error, 0 warnings, 0 info (1 total)' in result.stdout
    assert '  ok    a.pdf: 0 errors, 0 warnings' in result.stdout
    error_line = next(
        line for line in result.stdout.splitlines() if line.startswith('  error ')
    )
    assert error_line.startswith('  error broken.pdf: ')
    assert 'Cannot open PDF' in error_line
    # One line, relative path only.
    assert '\n' not in error_line
    assert str(tmp_path) not in result.stdout


def test_findings_are_pluralized_and_summed(tmp_path):
    root = _root(tmp_path)
    _warnings(root, 'a.pdf')
    _warnings(root, 'b.pdf')

    result = run_dir(root)

    assert result.returncode == 0, result.stderr
    assert 'files: 2 (2 audited, 0 failed)' in result.stdout
    assert 'findings: 0 errors, 10 warnings, 0 info (10 total)' in result.stdout
    assert '  ok    a.pdf: 0 errors, 5 warnings' in result.stdout


# --- --fail-on exit codes ---------------------------------------------------


def test_fail_on_error_gates_a_failed_file(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _broken(root, 'broken.pdf')

    result = run_dir(root, '--fail-on', 'error', '--quiet')

    assert result.returncode == 1
    assert result.stdout == ''
    assert 'pdf-inspector: 1 audit error(s) including 1 failed file(s) found' in (
        result.stderr
    )
    assert '(fail-on error)' in result.stderr
    assert result.stderr.strip().count('\n') == 0


def test_fail_on_warning_gates_warnings(tmp_path):
    root = _root(tmp_path)
    _warnings(root)

    warned = run_dir(root, '--fail-on', 'warning', '--quiet')
    assert warned.returncode == 1
    assert '5 warning(s)' in warned.stderr
    assert '(fail-on warning)' in warned.stderr

    errors_only = run_dir(root, '--fail-on', 'error', '--quiet')
    assert errors_only.returncode == 0, errors_only.stderr
    assert errors_only.stderr == ''


def test_fail_on_none_never_fails_on_findings_or_failed_files(tmp_path):
    root = _root(tmp_path)
    _warnings(root, 'a.pdf')
    _broken(root, 'broken.pdf')

    for fail_on in ('none',):
        result = run_dir(root, '--fail-on', fail_on, '--quiet')

        assert result.returncode == 0, result.stderr
        assert result.stdout == ''


def test_fail_on_reason_is_printed_even_without_quiet(tmp_path):
    root = _root(tmp_path)
    _broken(root)

    result = run_dir(root, '--fail-on', 'error')

    assert result.returncode == 1
    assert 'files: 1 (0 audited, 1 failed)' in result.stdout
    assert 'pdf-inspector: ' in result.stderr


def test_audit_dir_failure_reason_helper():
    clean = _batch([_ok_entry('a.pdf')])
    warned = _batch([_ok_entry('a.pdf', warnings=2)])
    broken = _batch([_ok_entry('a.pdf'), _error_entry('b.pdf')])

    assert cli.audit_dir_failure_reason(clean, 'none') is None
    assert cli.audit_dir_failure_reason(clean, 'error') is None
    assert cli.audit_dir_failure_reason(clean, 'warning') is None
    assert cli.audit_dir_failure_reason(warned, 'error') is None
    assert 'fail-on warning' in cli.audit_dir_failure_reason(warned, 'warning')

    # A failed file is an error, so `warning` sees it too; no failures note when
    # every file was audited.
    assert 'including 1 failed file(s)' in cli.audit_dir_failure_reason(
        broken, 'error'
    )
    assert 'fail-on warning' in cli.audit_dir_failure_reason(broken, 'warning')
    assert 'including' not in cli.audit_dir_failure_reason(warned, 'warning')

    with pytest.raises(ValueError):
        cli.audit_dir_failure_reason(clean, 'sometimes')


# --- include / exclude / max-files -----------------------------------------


def test_include_and_exclude_filter_the_batch(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'top.pdf')
    _valid(root, 'reports/a.pdf')
    _valid(root, 'reports/draft/b.pdf')

    included = dir_json(root, '--include', 'reports/*')
    assert [entry['path'] for entry in included['files']] == [
        'reports/a.pdf',
        'reports/draft/b.pdf',
    ]
    assert included['summary']['files'] == 2

    # Exclude always wins over include.
    filtered = dir_json(
        root, '--include', 'reports/*', '--exclude', 'reports/draft/*'
    )
    assert [entry['path'] for entry in filtered['files']] == ['reports/a.pdf']

    excluded = dir_json(root, '--exclude', 'reports/*')
    assert [entry['path'] for entry in excluded['files']] == ['top.pdf']


def test_repeated_include_globs_are_ored(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _valid(root, 'b.pdf')
    _valid(root, 'c.pdf')

    result = run_dir(root, '--include', 'a.pdf', '--include', 'c.pdf')
    json_result = run_dir(
        root, '--include', 'a.pdf', '--include', 'c.pdf', '--format', 'json'
    )

    assert result.returncode == 0, result.stderr
    assert 'files: 2 (2 audited, 0 failed)' in result.stdout
    assert [entry['path'] for entry in json.loads(json_result.stdout)['files']] == [
        'a.pdf',
        'c.pdf',
    ]


def test_max_files_over_the_limit_is_a_one_line_error(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _valid(root, 'b.pdf')

    result = run_dir(root, '--max-files', '1')

    _one_line_error(result, 'found 2 PDF files')
    assert 'limit of 1' in result.stderr
    assert 'max_files' in result.stderr


def test_max_files_accepts_the_exact_count(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _valid(root, 'b.pdf')

    result = run_dir(root, '--max-files', '2', '--quiet')

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('value', ['0', '5001', '-1'])
def test_max_files_out_of_range_is_a_one_line_error(tmp_path, value):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')

    result = run_dir(root, '--max-files', value)

    _one_line_error(result, 'between 1 and 5000')


def test_non_integer_max_files_is_an_argparse_error(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')

    result = run_dir(root, '--max-files', 'lots')

    assert result.returncode == 2
    assert result.stdout == ''
    assert 'invalid int value' in result.stderr
    assert 'Traceback' not in result.stderr


# --- JSON output ------------------------------------------------------------


def test_json_matches_the_batch_contract(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _broken(root, 'broken.pdf')

    data = dir_json(root)

    assert list(data) == BATCH_KEYS
    assert data['schemaVersion'] == 1
    assert data['tool']['name'] == 'pdf-inspector'
    assert list(data['root']) == ['name', 'files', 'bytes']
    assert data['root']['name'] == root.name
    assert list(data['summary']) == SUMMARY_KEYS
    assert data['summary'] == {
        'files': 2,
        'audited': 1,
        'failed': 1,
        # The engine counts findings only here; the failed file shows up once in
        # ``errors`` (and in the summary's ``(N total)``).
        'findings': 0,
        'errors': 1,
        'warnings': 0,
        'info': 0,
    }
    assert [entry['path'] for entry in data['files']] == ['a.pdf', 'broken.pdf']
    assert [entry['status'] for entry in data['files']] == ['ok', 'error']


def test_json_has_no_absolute_paths_or_timestamps(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'reports/a.pdf')
    _broken(root, 'reports/broken.pdf')

    result = run_dir(root, '--format', 'json')

    assert result.returncode == 0, result.stderr
    assert result.stderr.splitlines() == [
        'audit-dir: [1/2] reports/a.pdf',
        'audit-dir: [2/2] reports/broken.pdf',
    ]
    json.loads(result.stdout)
    assert str(tmp_path) not in result.stdout
    assert str(root) not in result.stdout
    assert str(tmp_path) not in result.stderr
    assert not TIMESTAMP.search(result.stdout)
    for entry in json.loads(result.stdout)['files']:
        assert not Path(entry['path']).is_absolute()


def test_json_is_deterministic_across_runs(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _valid(root, 'reports/b.pdf')
    _broken(root, 'reports/c.pdf')

    first = run_dir(root, '--format', 'json')
    second = run_dir(root, '--format', 'json')

    assert first.returncode == second.returncode == 0
    assert first.stdout == second.stdout


def test_json_output_file_equals_the_stdout_payload(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    output = tmp_path / 'batch.json'

    result = run_dir(root, '--format', 'json', '--output', str(output))

    assert result.returncode == 0, result.stderr
    # The payload goes to the file; stdout keeps the human summary.
    assert not result.stdout.lstrip().startswith('{')
    assert 'files: 1 (1 audited, 0 failed)' in result.stdout
    assert json.loads(output.read_text(encoding='utf-8')) == dir_json(root)
    assert output.read_text(encoding='utf-8').endswith('\n')
    assert b'\r\n' not in output.read_bytes()


def test_json_output_survives_a_non_utf8_file_name(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'ok.pdf')
    weird = _non_utf8_pdf(root)
    output = tmp_path / 'batch.json'

    result = run_dir(root, '--format', 'json', '--output', str(output))

    # A file name that is not valid UTF-8 is data, not a crash: exit 0 and a
    # real artifact instead of the codec error and the 0-byte file it used to
    # produce.
    assert result.returncode == 0, result.stderr
    assert 'cannot encode' not in result.stderr
    assert output.stat().st_size > 0
    payload = json.loads(output.read_bytes().decode('utf-8'))
    paths = [entry['path'] for entry in payload['files']]
    assert paths == ['bad\\udcff.pdf', 'ok.pdf']
    assert weird.name not in paths
    assert payload['summary'] == {
        'files': 2,
        'audited': 2,
        'failed': 0,
        'findings': 0,
        'errors': 0,
        'warnings': 0,
        'info': 0,
    }
    # The human summary and the progress lines stay one line and ASCII-safe.
    assert 'files: 2 (2 audited, 0 failed)' in result.stdout
    assert 'audit-dir: [1/2] bad\\udcff.pdf' in result.stderr


def test_quiet_json_keeps_stdout_pure_and_silences_progress(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')

    result = run_dir(root, '--format', 'json', '--quiet')

    assert result.returncode == 0
    assert result.stderr == ''
    assert result.stdout.lstrip().startswith('{')
    assert json.loads(result.stdout)['summary']['files'] == 1


def test_quiet_suppresses_the_summary_and_the_progress(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')

    result = run_dir(root, '--quiet')

    assert result.returncode == 0
    assert result.stdout == ''
    assert result.stderr == ''


def test_quiet_with_output_writes_the_file_without_stdout(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    output = tmp_path / 'batch.json'

    result = run_dir(
        root, '--format', 'json', '--output', str(output), '--quiet'
    )

    assert result.returncode == 0
    assert result.stdout == ''
    assert result.stderr == ''
    assert json.loads(output.read_text(encoding='utf-8'))['summary']['files'] == 1


# --- progress ---------------------------------------------------------------


def test_progress_lines_go_to_stderr_in_discovery_order(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _valid(root, 'reports/b.pdf')

    result = run_dir(root)

    assert result.returncode == 0, result.stderr
    assert result.stderr.splitlines() == [
        'audit-dir: [1/2] a.pdf',
        'audit-dir: [2/2] reports/b.pdf',
    ]
    assert 'files: 2 (2 audited, 0 failed)' in result.stdout


def test_progress_counter_is_one_based_for_a_single_file(tmp_path):
    root = _root(tmp_path)
    _valid(root)

    result = run_dir(root, '--format', 'json')

    assert result.returncode == 0, result.stderr
    assert result.stderr == 'audit-dir: [1/1] a.pdf\n'


def test_no_progress_for_an_empty_directory(tmp_path):
    result = run_dir(_root(tmp_path, 'empty'))

    assert result.returncode == 0
    assert result.stderr == ''


def test_progress_flattens_control_characters(capsys):
    # A file name may contain a control byte on POSIX; the progress line must
    # stay printable and one line long.
    cli._audit_dir_progress(0, 2, 'reports/\x1b[31mred.pdf')

    captured = capsys.readouterr()
    assert captured.err == 'audit-dir: [1/2] reports/[31mred.pdf\n'
    assert '\x1b' not in captured.err


# --- --output safety --------------------------------------------------------


def test_output_cannot_overwrite_a_pdf_under_the_root(tmp_path):
    root = _root(tmp_path)
    target = _valid(root, 'reports/a.pdf')
    original = target.read_bytes()

    result = run_dir(root, '--format', 'json', '--output', str(target))

    _one_line_error(result, 'must not overwrite a PDF under the audit root')
    assert target.read_bytes() == original


def test_output_cannot_overwrite_the_root_itself(tmp_path):
    root = _root(tmp_path)
    _valid(root)

    result = run_dir(root, '--format', 'json', '--output', str(root))

    _one_line_error(result, 'must not overwrite the audit root directory')
    assert root.is_dir()


def test_output_cannot_overwrite_an_uppercase_pdf_under_the_root(tmp_path):
    root = _root(tmp_path)
    target = _valid(root, 'reports/UPPER.PDF')
    original = target.read_bytes()

    result = run_dir(root, '--format', 'json', '--output', str(target))

    _one_line_error(result, 'must not overwrite a PDF under the audit root')
    assert target.read_bytes() == original


def test_output_with_the_summary_format_writes_and_prints_the_summary(tmp_path):
    root = _root(tmp_path)
    _valid(root)
    output = tmp_path / 'batch.txt'

    result = run_dir(root, '--output', str(output))

    assert result.returncode == 0, result.stderr
    assert 'files: 1 (1 audited, 0 failed)' in result.stdout
    assert output.read_text(encoding='utf-8') == result.stdout


def test_output_may_be_written_outside_the_root(tmp_path):
    root = _root(tmp_path)
    _valid(root)
    output = tmp_path / 'artifacts' / 'batch.json'
    output.parent.mkdir()

    result = run_dir(root, '--format', 'json', '--output', str(output), '--quiet')

    assert result.returncode == 0, result.stderr
    assert output.exists()


def test_output_to_missing_directory_fails(tmp_path):
    root = _root(tmp_path)
    _valid(root)
    output = tmp_path / 'missing' / 'batch.json'

    result = run_dir(
        root, '--format', 'json', '--output', str(output), '--quiet'
    )

    _one_line_error(result, 'output directory does not exist')


def test_unencodable_payload_is_a_user_error_not_a_traceback(tmp_path):
    # Every engine sanitises the paths it reports, so this guards the last
    # resort: writing a payload with a lone surrogate must still be a one-line
    # CliError instead of a codec traceback and a misleadingly empty file.
    output = tmp_path / 'payload.json'

    with pytest.raises(cli.CliError, match='cannot encode'):
        cli._write_output(str(output), 'bad\udcff.pdf')


# --- HTML output ------------------------------------------------------------


def test_html_output_file_is_a_standalone_report(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _broken(root, 'reports/broken.pdf')
    output = tmp_path / 'batch.html'

    result = run_dir(root, '--format', 'html', '--output', str(output))

    assert result.returncode == 0, result.stderr
    body = output.read_text(encoding='utf-8')
    assert body.startswith('<!DOCTYPE html>')
    assert body.endswith('</html>\n')
    assert '<title>PDF audit report - 2 files</title>' in body
    assert '<script' not in body
    assert 'http://' not in body and 'https://' not in body
    assert '<td class="mono">reports/broken.pdf</td>' in body
    # The payload goes to the file; stdout keeps the human summary.
    assert not result.stdout.lstrip().startswith('<!DOCTYPE')
    assert 'files: 2 (1 audited, 1 failed)' in result.stdout


def test_html_without_output_goes_to_stdout(tmp_path):
    root = _root(tmp_path)
    _valid(root)

    result = run_dir(root, '--format', 'html', '--quiet')

    assert result.returncode == 0, result.stderr
    assert result.stderr == ''
    assert result.stdout.startswith('<!DOCTYPE html>')
    assert result.stdout.endswith('</html>\n')
    assert '<title>PDF audit report - 1 file</title>' in result.stdout


def test_html_is_deterministic_and_leaks_no_absolute_path_or_timestamp(tmp_path):
    root = _root(tmp_path)
    _warnings(root, 'reports/a.pdf')
    _broken(root, 'reports/broken.pdf')

    first = run_dir(root, '--format', 'html', '--quiet')
    second = run_dir(root, '--format', 'html', '--quiet')

    assert first.returncode == second.returncode == 0
    assert first.stdout == second.stdout
    assert not TIMESTAMP.search(first.stdout)
    assert str(tmp_path) not in first.stdout
    assert str(root) not in first.stdout
    for path in re.findall(r'<td class="mono">([^<]+)</td>', first.stdout):
        assert not Path(path).is_absolute(), path


def test_html_renders_a_failed_file_as_one_error_block(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _broken(root, 'broken.pdf')

    result = run_dir(root, '--format', 'html')

    assert result.returncode == 0, result.stderr
    assert result.stdout.count('<div class="error-block">') == 1
    assert '<p class="error">Cannot open PDF' in result.stdout
    assert '<tr><th scope="row">Failed</th><td>1</td></tr>' in result.stdout


# --- --stats ----------------------------------------------------------------

STATS_KEYS = ['schemaVersion', 'tool', 'root', 'summary']


def test_stats_file_has_the_compact_counts_contract(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _warnings(root, 'reports/b.pdf')
    _broken(root, 'reports/c.pdf')
    stats = tmp_path / 'stats.json'

    result = run_dir(
        root,
        '--format',
        'json',
        '--output',
        str(tmp_path / 'batch.json'),
        '--stats',
        str(stats),
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(stats.read_text(encoding='utf-8'))
    assert list(data) == STATS_KEYS
    assert data['schemaVersion'] == 1
    assert set(data['tool']) == {'name', 'version'}
    assert data['tool']['name'] == 'pdf-inspector'
    assert list(data['root']) == ['name', 'files', 'bytes']
    assert data['root']['name'] == root.name
    assert list(data['summary']) == SUMMARY_KEYS
    assert data['summary'] == {
        'files': 3,
        'audited': 2,
        'failed': 1,
        'findings': 5,
        'errors': 1,
        'warnings': 5,
        'info': 0,
    }
    # The artifact is counts only: no per-file findings and no file list.
    assert 'files' not in data
    assert 'findings' not in data
    assert str(tmp_path) not in stats.read_text(encoding='utf-8')
    assert stats.read_text(encoding='utf-8').endswith('\n')


def test_stats_are_written_even_with_the_summary_format(tmp_path):
    root = _root(tmp_path)
    _valid(root)
    stats = tmp_path / 'stats.json'

    result = run_dir(root, '--stats', str(stats))

    assert result.returncode == 0, result.stderr
    assert 'files: 1 (1 audited, 0 failed)' in result.stdout
    assert json.loads(stats.read_text(encoding='utf-8'))['summary']['files'] == 1


def test_stats_are_written_next_to_the_html_payload(tmp_path):
    root = _root(tmp_path)
    _valid(root)
    stats = tmp_path / 'stats.json'
    output = tmp_path / 'batch.html'

    result = run_dir(
        root, '--format', 'html', '--output', str(output), '--stats', str(stats)
    )

    assert result.returncode == 0, result.stderr
    assert output.read_text(encoding='utf-8').startswith('<!DOCTYPE html>')
    assert json.loads(stats.read_text(encoding='utf-8'))['summary']['files'] == 1


def test_stats_are_written_when_the_threshold_fails_and_quiet_is_set(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _broken(root, 'broken.pdf')
    stats = tmp_path / 'stats.json'

    result = run_dir(root, '--fail-on', 'error', '--quiet', '--stats', str(stats))

    assert result.returncode == 1
    assert result.stdout == ''
    data = json.loads(stats.read_text(encoding='utf-8'))
    assert data['summary']['failed'] == 1
    assert data['summary']['errors'] == 1


def test_stats_are_byte_identical_across_runs(tmp_path):
    root = _root(tmp_path)
    _valid(root, 'a.pdf')
    _broken(root, 'b.pdf')
    first = tmp_path / 'first.json'
    second = tmp_path / 'second.json'

    assert run_dir(root, '--stats', str(first), '--quiet').returncode == 0
    assert run_dir(root, '--stats', str(second), '--quiet').returncode == 0

    assert first.read_bytes() == second.read_bytes()
    assert b'\r\n' not in first.read_bytes()


def test_stats_cannot_overwrite_a_pdf_under_the_root(tmp_path):
    root = _root(tmp_path)
    target = _valid(root, 'reports/a.pdf')
    original = target.read_bytes()

    result = run_dir(root, '--stats', str(target))

    _one_line_error(result, 'must not overwrite a PDF under the audit root')
    assert target.read_bytes() == original


def test_stats_and_output_must_be_different_files(tmp_path):
    root = _root(tmp_path)
    _valid(root)
    target = tmp_path / 'batch.json'

    result = run_dir(
        root, '--format', 'json', '--output', str(target), '--stats', str(target)
    )

    _one_line_error(result, 'output path and stats path must be different files')
    assert not target.exists()


def test_stats_to_missing_directory_fails(tmp_path):
    root = _root(tmp_path)
    _valid(root)
    stats = tmp_path / 'missing' / 'stats.json'

    result = run_dir(root, '--stats', str(stats), '--quiet')

    _one_line_error(result, 'output directory does not exist')


# --- summary renderer edge cases -------------------------------------------


def test_summary_lists_at_most_fifty_files_then_counts_the_rest():
    entries = [_ok_entry(f'reports/{index:03d}.pdf') for index in range(60)]

    text = cli.format_audit_dir_summary(_batch(entries))

    listed = [line for line in text.splitlines() if line.startswith('  ok ')]
    assert len(listed) == cli.MAX_SUMMARY_FILES == 50
    assert listed[0] == '  ok    reports/000.pdf: 0 errors, 0 warnings'
    assert text.splitlines()[-1] == '  ... 10 more file(s)'
    assert 'reports/059.pdf' not in text


def test_summary_bounds_and_flattens_file_errors():
    long_error = 'Cannot open PDF: ' + 'x' * 500 + '\nafter the newline'
    entries = [_error_entry('broken.pdf', long_error)]

    text = cli.format_audit_dir_summary(_batch(entries))

    error_lines = [line for line in text.splitlines() if line.startswith('  error ')]
    assert len(error_lines) == 1
    (line,) = error_lines
    assert line.startswith('  error broken.pdf: Cannot open PDF: ')
    assert line.endswith('...')
    assert len(line) <= len('  error broken.pdf: ') + cli.MAX_SUMMARY_ERROR_CHARS
    assert 'after the newline' not in text


def test_summary_never_prints_control_characters():
    entries = [_ok_entry('reports/\x1b[31mred.pdf')]

    text = cli.format_audit_dir_summary(_batch(entries))

    assert '\x1b' not in text
    assert '  ok    reports/[31mred.pdf: 0 errors, 0 warnings' in text


def test_summary_pluralizes_a_single_error_and_warning():
    entries = [_ok_entry('a.pdf', errors=1, warnings=1)]

    text = cli.format_audit_dir_summary(_batch(entries))

    assert 'findings: 1 error, 1 warning, 0 info (2 total)' in text
    assert '  ok    a.pdf: 1 error, 1 warning' in text


def test_summary_of_an_empty_batch_says_no_files_were_found():
    text = cli.format_audit_dir_summary(_batch([]))

    assert text.splitlines() == [
        'pdf-inspector 0.3.3 - PDF audit directory',
        'root: docs',
        'files: 0 (0 audited, 0 failed)',
        'findings: 0 errors, 0 warnings, 0 info (0 total)',
        'no PDF files found',
    ]


def test_summary_falls_back_when_tool_or_root_labels_are_missing():
    result = _batch([_ok_entry('a.pdf')])
    result['tool'] = {}
    result['root'] = {'files': 1, 'bytes': 0}

    text = cli.format_audit_dir_summary(result)

    assert text.splitlines()[:2] == [
        'pdf-inspector 0.0.0 - PDF audit directory',
        'root: .',
    ]
    assert 'None' not in text


# --- parser wiring ----------------------------------------------------------


def test_parser_defaults():
    args = cli.build_parser().parse_args(['audit-dir', 'docs'])

    assert args.command == 'audit-dir'
    assert args.root == 'docs'
    assert args.include == []
    assert args.exclude == []
    assert args.max_files == cli.DEFAULT_MAX_FILES
    assert args.format == 'summary'
    assert args.output is None
    assert args.stats is None
    assert args.fail_on == 'none'
    assert args.quiet is False


def test_directory_formats_are_summary_json_and_html():
    parser = cli.build_parser()

    assert cli.AUDIT_DIR_FORMAT_CHOICES == ('summary', 'json', 'html')
    assert set(cli.AUDIT_DIR_FORMAT_CHOICES) < set(cli.AUDIT_FORMAT_CHOICES)
    with pytest.raises(SystemExit):
        parser.parse_args(['audit-dir', 'docs', '--format', 'sarif'])


@pytest.mark.parametrize(
    'flag', ['--baseline', '--baseline-output', '--waivers', '--sarif-uri']
)
def test_single_file_only_flags_are_not_registered_on_audit_dir(flag):
    parser = cli.build_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(['audit-dir', 'docs', flag, 'value'])


def test_an_unwired_directory_format_raises_instead_of_misrendering():
    # A format the subcommand does not offer must fail loudly rather than write
    # a summary into a .sarif artifact.
    with pytest.raises(ValueError, match='unsupported audit-dir format'):
        cli._render_audit_dir_payload(_batch([_ok_entry('a.pdf')]), 'sarif')


def test_help_documents_the_directory_audit():
    result = run_cli('audit-dir', '--help')

    assert result.returncode == 0
    assert '--include' in result.stdout
    assert '--exclude' in result.stdout
    assert '--max-files' in result.stdout
    assert '--stats' in result.stdout
    assert '--fail-on' in result.stdout
    assert '1..5000' in result.stdout
    assert 'single-file features' in result.stdout
    assert str(cli.DEFAULT_MAX_FILES) in result.stdout
