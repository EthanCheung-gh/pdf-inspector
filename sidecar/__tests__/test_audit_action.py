"""The composite audit action: format sarif, baseline/waiver inputs, outputs.

``audit/action.yml`` is a set of bash steps; GitHub runs them with ``bash -e``.
These tests reuse the harness of :mod:`test_diff_action` (extract the ``run:``
body of a named step and execute it under the same shell), so the input
validation, the SARIF/baseline/waiver wiring, the captured exit code, the
outputs and the step summary are covered without a real runner.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas

TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_DIR.parents[1]
CLI = REPO_ROOT / 'sidecar' / 'cli.py'
ACTION = REPO_ROOT / 'audit' / 'action.yml'

if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from test_diff_action import _run_step as _run_generic_step  # noqa: E402

VALIDATE_STEP = 'Validate inputs'
RUN_STEP = 'Run PDF audit'
WAIVER_REASON = 'Sample policy; tracked in DOC-1234'

# A file that promises a document body and never delivers one.
BROKEN_PDF = b'%PDF-1.4\nthis header promises a document body that never arrives\n'


def _run_step(name: str, *, env, cwd):
    """Run one ``audit/action.yml`` step (the harness defaults to the diff action)."""
    return _run_generic_step(name, env=env, cwd=cwd, path=ACTION)


# --- fixtures ---------------------------------------------------------------


def _text_pdf(path: Path) -> str:
    """A clean text-only PDF: it still has info findings to map into SARIF."""
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, invariant=1)
    canvas.setFont('Helvetica', 12)
    canvas.drawString(72, 720, 'Hello audit')
    canvas.showPage()
    canvas.save()
    return str(path)


def _warning_pdf(path: Path) -> str:
    """An image-only page drawn at ~2.9 dpi: two warnings plus the info findings."""
    buffer = io.BytesIO()
    Image.new('RGB', (8, 8), (180, 40, 40)).save(buffer, format='PNG')
    buffer.seek(0)
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, invariant=1)
    canvas.drawImage(ImageReader(buffer), 72, 400, width=200, height=200)
    canvas.showPage()
    canvas.save()
    return str(path)


@pytest.fixture(scope='module')
def workspace(tmp_path_factory):
    root = tmp_path_factory.mktemp('audit-action-workspace')
    pdf = _text_pdf(root / 'sample.pdf')

    # A real baseline + waiver policy built from the audited report, so the
    # fingerprints and pages always match the current run.
    baseline = root / 'baseline.json'
    generated = subprocess.run(
        [
            sys.executable,
            str(CLI),
            'audit',
            pdf,
            '--format',
            'json',
            '--output',
            str(baseline),
            '--fail-on',
            'none',
        ],
        capture_output=True,
        text=True,
    )
    assert generated.returncode == 0, generated.stderr

    report = json.loads(baseline.read_text(encoding='utf-8'))
    assert report['findings'], 'the sample must produce findings for the SARIF tests'
    waivers = root / 'waivers.json'
    waivers.write_text(
        json.dumps(
            {
                'schemaVersion': 1,
                'waivers': [
                    {
                        'fingerprint': finding['fingerprint'],
                        'page': finding['page'],
                        'reason': WAIVER_REASON,
                        'expires': '2999-12-31',
                    }
                    for finding in report['findings']
                ],
            }
        ),
        encoding='utf-8',
    )

    # A small directory tree for directory mode: one readable PDF plus one
    # damaged stub, so ``failed`` and the aggregate error count are non-zero.
    directory = root / 'docs'
    directory.mkdir()
    _text_pdf(directory / 'a.pdf')
    (directory / 'broken.pdf').write_bytes(BROKEN_PDF)

    return {
        'root': root,
        'pdf': pdf,
        'warning_pdf': _warning_pdf(root / 'warnings.pdf'),
        'directory': str(directory),
        'baseline': str(baseline),
        'waivers': str(waivers),
        'findings': report['findings'],
    }


def _validate_env(workspace, **overrides) -> dict[str, str]:
    env = {
        'INPUT_PATH': workspace['pdf'],
        'INPUT_FAIL_ON': 'none',
        'INPUT_FORMAT': 'sarif',
        'INPUT_JSON_PATH': '',
        'INPUT_REPORT_PATH': '',
        'INPUT_BASELINE_PATH': '',
        'INPUT_BASELINE_OUTPUT_PATH': '',
        'INPUT_WAIVERS_PATH': '',
        'INPUT_SARIF_PATH': '',
        'INPUT_SARIF_URI': '',
    }
    env.update(overrides)
    return env


def _run_env(workspace, tmp_path: Path, **overrides):
    outputs = tmp_path / 'github-output.txt'
    summary = tmp_path / 'github-summary.md'
    outputs.write_text('', encoding='utf-8')
    summary.write_text('', encoding='utf-8')
    env = {
        'ACTION_PATH': str(REPO_ROOT / 'audit'),
        'INPUT_PATH': workspace['pdf'],
        'INPUT_FAIL_ON': 'none',
        'INPUT_FORMAT': 'sarif',
        'INPUT_JSON_PATH': '',
        'INPUT_REPORT_PATH': '',
        'INPUT_BASELINE_PATH': '',
        'INPUT_BASELINE_OUTPUT_PATH': '',
        'INPUT_WAIVERS_PATH': '',
        'INPUT_SARIF_PATH': '',
        'INPUT_SARIF_URI': '',
        'RUNNER_TEMP_DIR': str(tmp_path / 'runner-temp'),
        'GITHUB_OUTPUT': str(outputs),
        'GITHUB_STEP_SUMMARY': str(summary),
    }
    env.update(overrides)
    return env, outputs, summary


def _outputs(outputs: Path) -> dict[str, str]:
    pairs = {}
    for line in outputs.read_text(encoding='utf-8').splitlines():
        key, _, value = line.partition('=')
        pairs[key] = value
    return pairs


def _sarif(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding='utf-8'))


# --- metadata ---------------------------------------------------------------


def test_action_documents_the_sarif_baseline_and_waiver_io():
    text = ACTION.read_text(encoding='utf-8')

    assert 'summary, json, html or sarif' in text
    for name in (
        '\n  baseline-path:\n',
        '\n  baseline-output-path:\n',
        '\n  waivers-path:\n',
        '\n  sarif-path:\n',
        '\n  sarif-uri:\n',
    ):
        assert name in text
    assert 'value: ${{ steps.audit.outputs.sarif-path }}' in text
    for flag in ('--baseline', '--baseline-output', '--waivers', '--sarif-uri'):
        assert flag in text
    assert 'pdf-inspector-audit.sarif' in text


# --- input validation -------------------------------------------------------


def test_validate_inputs_accepts_format_sarif(workspace):
    result = _run_step(VALIDATE_STEP, env=_validate_env(workspace), cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr


def test_validate_inputs_accepts_baseline_and_waivers(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(
            workspace,
            INPUT_BASELINE_PATH=workspace['baseline'],
            INPUT_WAIVERS_PATH=workspace['waivers'],
        ),
        cwd=workspace['root'],
    )

    assert result.returncode == 0, result.stdout + result.stderr


def test_validate_inputs_rejects_an_unknown_format(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_FORMAT='yaml'),
        cwd=workspace['root'],
    )

    assert result.returncode == 2
    assert "input 'format' must be one of summary, json, html, sarif" in (
        result.stdout + result.stderr
    )


def test_validate_inputs_rejects_a_missing_baseline(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_BASELINE_PATH='audit-artifacts/missing.json'),
        cwd=workspace['root'],
    )

    assert result.returncode == 2
    assert "input 'baseline-path' file not found" in result.stdout + result.stderr


def test_validate_inputs_rejects_a_baseline_url(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(
            workspace, INPUT_BASELINE_PATH='https://example.com/baseline.json'
        ),
        cwd=workspace['root'],
    )

    assert result.returncode == 2
    assert 'not a URL' in result.stdout + result.stderr


def test_validate_inputs_rejects_a_missing_waivers_file(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_WAIVERS_PATH='waivers/missing.json'),
        cwd=workspace['root'],
    )

    assert result.returncode == 2
    assert "input 'waivers-path' file not found" in result.stdout + result.stderr


def test_validate_inputs_rejects_a_waivers_url(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(
            workspace, INPUT_WAIVERS_PATH='https://example.com/waivers.json'
        ),
        cwd=workspace['root'],
    )

    assert result.returncode == 2
    assert 'not a URL' in result.stdout + result.stderr


def test_validate_inputs_rejects_a_comparison_without_a_baseline(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_BASELINE_OUTPUT_PATH='comparison.json'),
        cwd=workspace['root'],
    )

    assert result.returncode == 2
    assert "'baseline-output-path' requires 'baseline-path'" in (
        result.stdout + result.stderr
    )


def test_validate_inputs_rejects_a_sarif_uri_for_another_format(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(
            workspace, INPUT_FORMAT='json', INPUT_SARIF_URI='docs/report.pdf'
        ),
        cwd=workspace['root'],
    )

    assert result.returncode == 2
    assert "input 'sarif-uri' requires format 'sarif'" in result.stdout + result.stderr


@pytest.mark.parametrize(
    'name, key',
    [
        ('json-path', 'INPUT_JSON_PATH'),
        ('report-path', 'INPUT_REPORT_PATH'),
        ('sarif-path', 'INPUT_SARIF_PATH'),
    ],
)
def test_validate_inputs_rejects_a_comparison_path_colliding_with_an_artifact(
    workspace, name, key
):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(
            workspace,
            INPUT_BASELINE_PATH=workspace['baseline'],
            INPUT_BASELINE_OUTPUT_PATH='audit-artifacts/report.json',
            **{key: 'audit-artifacts/report.json'},
        ),
        cwd=workspace['root'],
    )

    combined = result.stdout + result.stderr
    assert result.returncode == 2, combined
    assert '::error::' in combined
    assert "input 'baseline-output-path' must differ from input" in combined
    assert f"'{name}'" in combined
    assert 'both are audit-artifacts/report.json' in combined


def test_validate_inputs_normalises_dot_slashes_before_comparing_paths(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(
            workspace,
            INPUT_BASELINE_PATH=workspace['baseline'],
            INPUT_BASELINE_OUTPUT_PATH='./audit-artifacts/comparison.json',
            INPUT_JSON_PATH='audit-artifacts/comparison.json',
        ),
        cwd=workspace['root'],
    )

    combined = result.stdout + result.stderr
    assert result.returncode == 2, combined
    assert "'baseline-output-path' must differ from input 'json-path'" in combined


def test_validate_inputs_accepts_distinct_comparison_and_artifact_paths(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(
            workspace,
            INPUT_FORMAT='sarif',
            INPUT_BASELINE_PATH=workspace['baseline'],
            INPUT_BASELINE_OUTPUT_PATH='audit-artifacts/comparison.json',
            INPUT_JSON_PATH='audit-artifacts/report.json',
            INPUT_REPORT_PATH='audit-artifacts/report.html',
            INPUT_SARIF_PATH='audit-artifacts/report.sarif',
        ),
        cwd=workspace['root'],
    )

    assert result.returncode == 0, result.stdout + result.stderr


def test_validate_inputs_accepts_a_comparison_path_with_empty_artifact_paths(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(
            workspace,
            INPUT_BASELINE_PATH=workspace['baseline'],
            INPUT_BASELINE_OUTPUT_PATH='audit-artifacts/comparison.json',
        ),
        cwd=workspace['root'],
    )

    assert result.returncode == 0, result.stdout + result.stderr


# --- directory mode input validation ---------------------------------------


def _directory_env(workspace, **overrides) -> dict[str, str]:
    """Validation env for a directory ``path`` (the single-file inputs empty)."""
    env = _validate_env(
        workspace, INPUT_PATH=workspace['directory'], INPUT_FORMAT='json'
    )
    env.update(overrides)
    return env


@pytest.mark.parametrize('fmt', ['summary', 'json', 'html'])
def test_validate_inputs_accepts_a_directory(workspace, fmt):
    result = _run_step(
        VALIDATE_STEP,
        env=_directory_env(workspace, INPUT_FORMAT=fmt),
        cwd=workspace['root'],
    )

    assert result.returncode == 0, result.stdout + result.stderr


def test_validate_inputs_accepts_directory_artifact_paths(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_directory_env(
            workspace,
            INPUT_JSON_PATH='audit-artifacts/report.json',
            INPUT_REPORT_PATH='audit-artifacts/report.html',
        ),
        cwd=workspace['root'],
    )

    assert result.returncode == 0, result.stdout + result.stderr


def test_validate_inputs_rejects_sarif_for_a_directory(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_directory_env(workspace, INPUT_FORMAT='sarif'),
        cwd=workspace['root'],
    )

    combined = result.stdout + result.stderr
    assert result.returncode == 2
    assert '::error::' in combined
    assert "input 'format' must be one of summary, json, html" in combined
    assert 'SARIF is a single-file feature' in combined


@pytest.mark.parametrize(
    'key, fragment',
    [
        ('INPUT_BASELINE_PATH', "'baseline-path' is not supported"),
        ('INPUT_BASELINE_OUTPUT_PATH', "'baseline-output-path' is not supported"),
        ('INPUT_WAIVERS_PATH', "'waivers-path' is not supported"),
        ('INPUT_SARIF_PATH', "'sarif-path' is not supported"),
        ('INPUT_SARIF_URI', "'sarif-uri' is not supported"),
    ],
)
def test_validate_inputs_rejects_single_file_inputs_for_a_directory(
    workspace, key, fragment
):
    result = _run_step(
        VALIDATE_STEP,
        env=_directory_env(
            workspace,
            # A path that does not exist proves the directory check runs before
            # the "file not found" check.
            **{key: 'audit-artifacts/does-not-exist.json'},
        ),
        cwd=workspace['root'],
    )

    combined = result.stdout + result.stderr
    assert result.returncode == 2, combined
    assert '::error::' in combined
    assert fragment in combined
    assert 'single-file feature' in combined or 'no SARIF output' in combined
    assert 'file not found' not in combined


def test_validate_inputs_rejects_a_missing_path(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_PATH='missing.pdf'),
        cwd=workspace['root'],
    )

    combined = result.stdout + result.stderr
    assert result.returncode == 2
    assert "input 'path' not found" in combined


@pytest.mark.skipif(os.name != 'posix', reason='mkfifo is POSIX only')
def test_validate_inputs_rejects_a_path_that_is_neither_file_nor_directory(
    workspace, tmp_path
):
    fifo = tmp_path / 'pipe'
    os.mkfifo(fifo)

    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_PATH=str(fifo)),
        cwd=workspace['root'],
    )

    combined = result.stdout + result.stderr
    assert result.returncode == 2
    assert "must be a regular PDF file or a directory" in combined


# --- run step ---------------------------------------------------------------


def test_run_step_writes_the_default_sarif_path_in_the_runner_temp(workspace, tmp_path):
    env, outputs, summary = _run_env(workspace, tmp_path)

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr
    default = Path(env['RUNNER_TEMP_DIR']) / 'pdf-inspector-audit.sarif'
    written = _outputs(outputs)
    assert written['exit-code'] == '0'
    assert written['sarif-path'] == str(default)
    assert written['json-path'] == ''
    assert written['report-path'] == ''

    data = _sarif(default)
    assert data['version'] == '2.1.0'
    assert data['runs'][0]['results']
    summary_text = summary.read_text(encoding='utf-8')
    assert '| format | `sarif` |' in summary_text
    assert f'| SARIF | `{default}` |' in summary_text


def test_run_step_honours_an_explicit_sarif_path(workspace, tmp_path):
    target = tmp_path / 'audit-artifacts' / 'action.sarif'
    env, outputs, summary = _run_env(workspace, tmp_path, INPUT_SARIF_PATH=str(target))

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr
    assert target.is_file() and target.stat().st_size > 0
    assert _outputs(outputs)['sarif-path'] == str(target)
    assert _sarif(target)['version'] == '2.1.0'
    assert f'| SARIF | `{target}` |' in summary.read_text(encoding='utf-8')


def test_run_step_passes_the_baseline_to_the_sarif_pass(workspace, tmp_path):
    comparison = tmp_path / 'comparison.json'
    env, outputs, summary = _run_env(
        workspace,
        tmp_path,
        INPUT_BASELINE_PATH=workspace['baseline'],
        INPUT_BASELINE_OUTPUT_PATH=str(comparison),
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr
    data = _sarif(_outputs(outputs)['sarif-path'])
    states = [item.get('baselineState') for item in data['runs'][0]['results']]
    # The baseline is the same PDF: every finding already existed.
    assert states == ['unchanged'] * len(data['runs'][0]['results'])
    assert json.loads(comparison.read_text(encoding='utf-8'))['summary']['new'] == 0

    summary_text = summary.read_text(encoding='utf-8')
    assert f'| baseline | `{workspace["baseline"]}` |' in summary_text
    assert f'| baseline comparison | `{comparison}` |' in summary_text


def test_run_step_maps_waivers_to_suppressions(workspace, tmp_path):
    env, outputs, summary = _run_env(
        workspace, tmp_path, INPUT_WAIVERS_PATH=workspace['waivers']
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr
    data = _sarif(_outputs(outputs)['sarif-path'])
    results = data['runs'][0]['results']
    assert results
    for item in results:
        assert item['suppressions'] == [
            {
                'kind': 'external',
                'status': 'accepted',
                'justification': WAIVER_REASON,
            }
        ]
    assert f'| waivers | `{workspace["waivers"]}` |' in summary.read_text(
        encoding='utf-8'
    )


def test_secondary_passes_receive_the_same_baseline_and_waivers(workspace, tmp_path):
    json_path = tmp_path / 'audit-artifacts' / 'report.json'
    sarif_path = tmp_path / 'audit-artifacts' / 'report.sarif'
    comparison = tmp_path / 'comparison.json'
    env, outputs, summary = _run_env(
        workspace,
        tmp_path,
        INPUT_FORMAT='summary',
        INPUT_JSON_PATH=str(json_path),
        INPUT_SARIF_PATH=str(sarif_path),
        INPUT_BASELINE_PATH=workspace['baseline'],
        INPUT_BASELINE_OUTPUT_PATH=str(comparison),
        INPUT_WAIVERS_PATH=workspace['waivers'],
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr
    written = _outputs(outputs)
    assert written['sarif-path'] == str(sarif_path)
    assert written['json-path'] == str(json_path)

    report = json.loads(json_path.read_text(encoding='utf-8'))
    data = _sarif(sarif_path)
    results = data['runs'][0]['results']
    # Both secondary passes saw the same report, the same policy and the same
    # comparison, so the counts and the suppressions agree.
    assert len(results) == len(report['findings'])
    assert all('suppressions' in item for item in results)
    assert json.loads(comparison.read_text(encoding='utf-8'))['summary']['waived'] == len(
        results
    )

    summary_text = summary.read_text(encoding='utf-8')
    assert f'| JSON | `{json_path}` |' in summary_text
    assert f'| SARIF | `{sarif_path}` |' in summary_text


def test_run_step_still_fails_the_step_on_a_matched_threshold(workspace, tmp_path):
    env, outputs, _summary = _run_env(
        workspace,
        tmp_path,
        INPUT_PATH=workspace['warning_pdf'],
        INPUT_FAIL_ON='warning',
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 1, result.stdout + result.stderr
    written = _outputs(outputs)
    assert written['exit-code'] == '1'
    # The payload is still written before the action reports the failure.
    assert _sarif(written['sarif-path'])['runs'][0]['results']


def test_run_step_reports_a_cli_error_as_exit_code_two(workspace, tmp_path):
    # ``format: summary`` keeps the outputs reachable: with a payload format the
    # action refuses to publish outputs for a run that wrote no payload.
    env, outputs, _summary = _run_env(
        workspace,
        tmp_path,
        INPUT_FORMAT='summary',
        INPUT_BASELINE_PATH='does-not-exist.json',
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 2, result.stdout + result.stderr
    assert _outputs(outputs)['exit-code'] == '2'
    assert 'cannot read baseline file' in result.stderr


def test_run_step_refuses_to_publish_outputs_when_no_payload_was_written(
    workspace, tmp_path
):
    env, outputs, _summary = _run_env(
        workspace, tmp_path, INPUT_BASELINE_PATH='does-not-exist.json'
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 2, result.stdout + result.stderr
    assert 'did not write' in result.stdout
    assert _outputs(outputs) == {}


# --- directory mode run step ------------------------------------------------


def _directory_run_env(workspace, tmp_path: Path, **overrides):
    """Run-step env whose ``path`` is the fixture directory."""
    env, outputs, summary = _run_env(
        workspace,
        tmp_path,
        INPUT_PATH=workspace['directory'],
        INPUT_FORMAT='json',
    )
    env.update(overrides)
    return env, outputs, summary


def _stats_path(env: dict[str, str]) -> Path:
    return Path(env['RUNNER_TEMP_DIR']) / 'pdf-inspector-audit-stats.json'


def test_run_step_audits_a_directory_to_the_default_json_and_stats(workspace, tmp_path):
    env, outputs, summary = _directory_run_env(workspace, tmp_path)

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr
    written = _outputs(outputs)
    default_json = Path(env['RUNNER_TEMP_DIR']) / 'pdf-inspector-audit.json'
    assert written['exit-code'] == '0'
    assert written['json-path'] == str(default_json)
    assert written['report-path'] == ''
    # Directory mode has no SARIF output at all.
    assert written['sarif-path'] == ''

    data = json.loads(default_json.read_text(encoding='utf-8'))
    assert list(data) == ['schemaVersion', 'tool', 'root', 'summary', 'files']
    assert data['root']['name'] == 'docs'
    assert data['files'], 'the fixture directory must be audited'
    assert all(not Path(entry['path']).is_absolute() for entry in data['files'])
    assert data['summary']['files'] == 2
    assert data['summary']['audited'] == 1
    assert data['summary']['failed'] == 1
    assert data['summary']['errors'] == 1

    stats = json.loads(_stats_path(env).read_text(encoding='utf-8'))
    assert list(stats) == ['schemaVersion', 'tool', 'root', 'summary']
    assert 'findings' not in stats
    assert list(stats['summary']) == [
        'files',
        'audited',
        'failed',
        'findings',
        'errors',
        'warnings',
        'info',
    ]
    assert stats['summary']['files'] == 2

    summary_text = summary.read_text(encoding='utf-8')
    assert '| mode | `directory` |' in summary_text
    assert '| root | `docs` |' in summary_text
    for key, value in (
        ('files', 2),
        ('audited', 1),
        ('failed', 1),
        ('errors', 1),
    ):
        assert f'| {key} | {value} |' in summary_text
    assert f'| JSON | `{default_json}` |' in summary_text
    assert '| SARIF |' not in summary_text


def test_run_step_audits_a_directory_to_an_explicit_html_report(workspace, tmp_path):
    report = tmp_path / 'audit-artifacts' / 'directory.html'
    env, outputs, summary = _directory_run_env(
        workspace, tmp_path, INPUT_FORMAT='html', INPUT_REPORT_PATH=str(report)
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr
    written = _outputs(outputs)
    assert written['report-path'] == str(report)
    assert written['json-path'] == ''

    body = report.read_text(encoding='utf-8')
    assert body.startswith('<!DOCTYPE html>')
    assert '<title>PDF audit report - 2 files</title>' in body
    assert '<script' not in body
    assert body.count('<div class="error-block">') == 1

    summary_text = summary.read_text(encoding='utf-8')
    assert f'| HTML | `{report}` |' in summary_text
    assert '| failed | 1 |' in summary_text


def test_run_step_writes_the_secondary_directory_json_report(workspace, tmp_path):
    json_path = tmp_path / 'audit-artifacts' / 'directory.json'
    env, outputs, summary = _directory_run_env(
        workspace, tmp_path, INPUT_FORMAT='summary', INPUT_JSON_PATH=str(json_path)
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr
    written = _outputs(outputs)
    assert written['json-path'] == str(json_path)
    assert json.loads(json_path.read_text(encoding='utf-8'))['summary']['files'] == 2
    assert _stats_path(env).is_file()

    summary_text = summary.read_text(encoding='utf-8')
    assert '| mode | `directory` |' in summary_text
    assert '| files | 2 |' in summary_text
    assert f'| JSON | `{json_path}` |' in summary_text


def test_run_step_still_fails_the_step_on_a_directory_threshold(workspace, tmp_path):
    env, outputs, _summary = _directory_run_env(
        workspace, tmp_path, INPUT_FAIL_ON='error'
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    # The damaged file counts as one aggregate error, so --fail-on error fails.
    assert result.returncode == 1, result.stdout + result.stderr
    written = _outputs(outputs)
    assert written['exit-code'] == '1'
    assert json.loads(
        Path(written['json-path']).read_text(encoding='utf-8')
    )['summary']['failed'] == 1
    assert _stats_path(env).is_file()


def test_run_step_directory_mode_never_passes_baseline_or_waivers(
    workspace, tmp_path
):
    # The validation step rejects these inputs for a directory; the run step
    # must not hand them to ``audit-dir`` either (it would exit 2 on the flags).
    comparison = tmp_path / 'audit-artifacts' / 'comparison.json'
    env, outputs, _summary = _directory_run_env(
        workspace,
        tmp_path,
        INPUT_BASELINE_PATH='does-not-exist.json',
        INPUT_BASELINE_OUTPUT_PATH=str(comparison),
        INPUT_WAIVERS_PATH='does-not-exist-waivers.json',
        INPUT_SARIF_URI='docs/a.pdf',
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr
    assert not comparison.exists()
    assert _outputs(outputs)['sarif-path'] == ''


def test_run_step_rejects_a_path_that_is_not_a_file_or_directory(workspace, tmp_path):
    env, _outputs_file, _summary = _directory_run_env(
        workspace, tmp_path, INPUT_PATH=str(tmp_path / 'missing')
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 2, result.stdout + result.stderr
    assert "must be a regular PDF file or a directory" in result.stdout
    assert not _stats_path(env).exists()


def test_action_documents_the_directory_mode():
    text = ACTION.read_text(encoding='utf-8')

    assert 'directory of PDFs' in text
    assert 'audit-dir' in text
    assert 'summary, json or html' in text
    assert 'pdf-inspector-audit-stats.json' in text
    assert "'baseline-path' is not supported when 'path' is a directory" in text
    assert 'Always empty in directory mode.' in text
    # Validation (which rejects directory + baseline/waivers/SARIF) is the first
    # step, so an unsupported combination fails before Python is installed.
    assert text.index('- name: Validate inputs') < text.index('- name: Set up Python')
