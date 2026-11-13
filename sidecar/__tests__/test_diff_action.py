"""The composite diff action: inputs, exit-code capture and step summary.

``action.yml`` is a set of bash steps; GitHub runs them with ``bash -e``.  These
tests extract the step scripts from the workflow file and execute them under
the same shell, so the input validation, the ``--fail-on reordered`` /
``--ignore-regions`` wiring, the captured non-zero exit code and the step
summary are covered without a real runner.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

REPO_ROOT = Path(__file__).resolve().parents[2]
ACTION = REPO_ROOT / 'action.yml'
WORKFLOW = REPO_ROOT / '.github' / 'workflows' / 'ci.yml'

VALIDATE_STEP = 'Validate inputs'
RUN_STEP = 'Run PDF diff'

# The page "Alpha" is drawn at x=100 in the old file and at x=140 in the new one:
# the fingerprint (text and object counts) is unchanged, so the page stays paired
# and is reported as reordered, while the shifted word is a maskable change.
IGNORE_REGION = {
    'oldPage': 1,
    'newPage': 2,
    'bbox': {'x0': 60, 'y0': 680, 'x1': 400, 'y1': 720},
}


# --- helpers ----------------------------------------------------------------


def _step_script(name: str, path: Path = ACTION) -> str:
    """Return the ``run:`` body of the workflow step called ``name``."""
    lines = path.read_text(encoding='utf-8').splitlines()
    marker = f'- name: {name}'
    start = next(
        (index for index, line in enumerate(lines) if line.strip() == marker), None
    )
    assert start is not None, f'{path.name} has no step named {name!r}'

    body: list[str] = []
    run_indent = None
    for line in lines[start + 1:]:
        stripped = line.strip()
        if run_indent is None:
            if stripped == 'run: |':
                run_indent = len(line) - len(line.lstrip())
            continue
        if not stripped:
            body.append('')
            continue
        if len(line) - len(line.lstrip()) <= run_indent:
            break
        body.append(line[run_indent + 2:])
    assert run_indent is not None, f'step {name!r} has no multi-line run script'
    return '\n'.join(body) + '\n'


def _run_step(
    name: str, *, env: dict[str, str], cwd: Path, path: Path = ACTION
) -> subprocess.CompletedProcess:
    """Run one workflow step under ``bash -e``, the shell GitHub uses."""
    environment = os.environ.copy()
    environment['PATH'] = (
        f'{Path(sys.executable).parent}{os.pathsep}{environment.get("PATH", "")}'
    )
    environment.update(env)
    return subprocess.run(
        ['bash', '-e', '-c', _step_script(name, path)],
        cwd=str(cwd),
        env=environment,
        capture_output=True,
        text=True,
    )


def _page(canvas, text: str, x: float) -> None:
    canvas.setFont('Helvetica', 12)
    canvas.drawString(x, 700, text)
    canvas.showPage()


def _pdf(path: Path, pages) -> str:
    # invariant=1 keeps the info dictionary deterministic: metadata is compared
    # by default, so a creation timestamp must not create documentChanges.
    canvas = rl_canvas.Canvas(str(path), pagesize=letter, invariant=1)
    for text, x in pages:
        _page(canvas, text, x)
    canvas.save()
    return str(path)


@pytest.fixture(scope='module')
def workspace(tmp_path_factory):
    root = tmp_path_factory.mktemp('action-workspace')
    old = _pdf(root / 'old.pdf', [('Alpha', 100), ('Beta', 100)])
    new = _pdf(root / 'new.pdf', [('Beta', 100), ('Alpha', 140)])
    regions = root / 'regions.json'
    regions.write_text(json.dumps([IGNORE_REGION]), encoding='utf-8')
    return {'root': root, 'old': old, 'new': new, 'regions': regions}


def _validate_env(workspace, **overrides) -> dict[str, str]:
    env = {
        'INPUT_OLD': workspace['old'],
        'INPUT_NEW': workspace['new'],
        'INPUT_FAIL_ON': 'reordered',
        'INPUT_FORMAT': 'json',
        'INPUT_IGNORE_REGIONS': str(workspace['regions']),
    }
    env.update(overrides)
    return env


def _run_env(workspace, tmp_path: Path, **overrides) -> tuple[dict[str, str], Path, Path]:
    outputs = tmp_path / 'github-output.txt'
    summary = tmp_path / 'github-summary.md'
    outputs.write_text('', encoding='utf-8')
    summary.write_text('', encoding='utf-8')
    out_dir = tmp_path / 'artifacts'
    env = {
        'ACTION_PATH': str(REPO_ROOT),
        'INPUT_OLD': workspace['old'],
        'INPUT_NEW': workspace['new'],
        'INPUT_FAIL_ON': 'reordered',
        'INPUT_FORMAT': 'json',
        'INPUT_JSON_PATH': str(out_dir / 'result.json'),
        'INPUT_REPORT_PATH': str(out_dir / 'report.html'),
        'INPUT_IGNORE_REGIONS': str(workspace['regions']),
        'RUNNER_TEMP_DIR': str(tmp_path / 'runner-temp'),
        'GITHUB_OUTPUT': str(outputs),
        'GITHUB_STEP_SUMMARY': str(summary),
    }
    env.update(overrides)
    return env, outputs, summary


# --- metadata ---------------------------------------------------------------


def test_action_documents_reordered_and_ignore_regions():
    text = ACTION.read_text(encoding='utf-8')

    assert 'page-count, reordered or none' in text
    assert '\n  ignore-regions:\n' in text
    assert '--ignore-regions' in text
    assert 'exit-code' in text and 'json-path' in text and 'report-path' in text
    # The non-zero exit is still captured with `set +e` before outputs are written.
    assert 'set +e' in text


def test_ci_workflow_asserts_the_reordered_fixture():
    text = WORKFLOW.read_text(encoding='utf-8')

    assert 'web-samples/diff-reordered.pdf' in text
    assert '--fail-on reordered' in text
    assert "summary['pagesReordered'] > 0" in text
    # The assertion is a G5 follow-up: it must not fail before the fixture exists.
    assert 'if [ ! -f "$REORDERED_FIXTURE" ]' in text
    assert 'G5 follow-up' in text
    # No visual screenshot job was added by this work package.
    assert 'diff-screenshots' not in text


# --- input validation -------------------------------------------------------


def test_validate_inputs_accepts_reordered_and_ignore_regions(workspace):
    result = _run_step(VALIDATE_STEP, env=_validate_env(workspace), cwd=workspace['root'])

    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize(
    'fail_on',
    ['any', 'added', 'removed', 'modified', 'page-count', 'reordered', 'none'],
)
def test_validate_inputs_accepts_every_fail_on_mode(workspace, fail_on):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_FAIL_ON=fail_on),
        cwd=workspace['root'],
    )

    assert result.returncode == 0, result.stdout + result.stderr


def test_validate_inputs_rejects_unknown_fail_on(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_FAIL_ON='shuffled'),
        cwd=workspace['root'],
    )

    assert result.returncode == 2
    assert "input 'fail-on' must be one of" in result.stdout + result.stderr


def test_validate_inputs_rejects_a_missing_ignore_regions_file(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_IGNORE_REGIONS='missing/regions.json'),
        cwd=workspace['root'],
    )

    assert result.returncode == 2
    assert "input 'ignore-regions' file not found" in result.stdout + result.stderr


def test_validate_inputs_treats_an_empty_ignore_regions_input_as_unset(workspace):
    result = _run_step(
        VALIDATE_STEP,
        env=_validate_env(workspace, INPUT_IGNORE_REGIONS=''),
        cwd=workspace['root'],
    )

    assert result.returncode == 0, result.stdout + result.stderr


# --- run step ---------------------------------------------------------------


def test_run_step_reports_reordered_pages_and_ignored_regions(workspace, tmp_path):
    env, outputs, summary = _run_env(workspace, tmp_path)

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    # A reordered pair matches --fail-on reordered: exit 1 is captured, not fatal.
    assert result.returncode == 1, result.stdout + result.stderr

    output_text = outputs.read_text(encoding='utf-8')
    assert 'exit-code=1' in output_text
    assert f'json-path={env["INPUT_JSON_PATH"]}' in output_text
    assert f'report-path={env["INPUT_REPORT_PATH"]}' in output_text

    data = json.loads(Path(env['INPUT_JSON_PATH']).read_text(encoding='utf-8'))
    assert data['summary']['pagesReordered'] == 1
    assert data['options']['ignoreRegions'] == [IGNORE_REGION]
    # The region masked the only change on the reordered page.
    assert data['summary']['objectsMoved'] == 0, data['summary']

    report = Path(env['INPUT_REPORT_PATH']).read_text(encoding='utf-8')
    assert '<!DOCTYPE html>' in report
    assert 'Page alignment' in report
    assert 'reordered</span>' in report
    assert '<table class="regions">' in report

    summary_text = summary.read_text(encoding='utf-8')
    assert '| fail-on | `reordered` |' in summary_text
    assert '| ignore regions | `' in summary_text
    match = re.search(
        r'\|\s*pages added / removed / changed / reordered\s*\|'
        r'\s*(\d+) / (\d+) / (\d+) / (\d+)\s*\|',
        summary_text,
    )
    assert match is not None, summary_text
    assert match.group(4) == '1', summary_text
    assert '| pages (old -> new) | 2 -> 2 |' in summary_text
    assert '| ignored regions | 1 |' in summary_text


def test_run_step_without_ignore_regions_keeps_the_moved_change(workspace, tmp_path):
    env, outputs, summary = _run_env(workspace, tmp_path, INPUT_IGNORE_REGIONS='')

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 1, result.stdout + result.stderr
    assert 'exit-code=1' in outputs.read_text(encoding='utf-8')

    data = json.loads(Path(env['INPUT_JSON_PATH']).read_text(encoding='utf-8'))
    assert data['summary']['objectsMoved'] == 1, data['summary']
    assert data['options']['ignoreRegions'] == []

    summary_text = summary.read_text(encoding='utf-8')
    assert '| ignored regions | 0 |' in summary_text
    # No PDF text is dumped into the summary: only counts and page numbers.
    assert 'Alpha' not in summary_text and 'Beta' not in summary_text


def test_run_step_summarises_when_only_a_text_summary_is_requested(workspace, tmp_path):
    env, outputs, summary = _run_env(
        workspace,
        tmp_path,
        INPUT_FORMAT='summary',
        INPUT_JSON_PATH='',
        INPUT_REPORT_PATH='',
    )

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 1, result.stdout + result.stderr
    output_text = outputs.read_text(encoding='utf-8')
    assert 'exit-code=1' in output_text
    assert 'json-path=\n' in output_text and 'report-path=\n' in output_text

    # The bounded secondary JSON pass still fills the step summary with counts.
    summary_text = summary.read_text(encoding='utf-8')
    assert '| pages (old -> new) | 2 -> 2 |' in summary_text
    assert '| ignored regions | 1 |' in summary_text
    assert 'Alpha' not in summary_text and 'Beta' not in summary_text


def test_run_step_keeps_outputs_when_the_diff_fails_on_any(workspace, tmp_path):
    env, outputs, summary = _run_env(workspace, tmp_path, INPUT_FAIL_ON='any')

    result = _run_step(RUN_STEP, env=env, cwd=workspace['root'])

    assert result.returncode == 1, result.stdout + result.stderr
    output_text = outputs.read_text(encoding='utf-8')
    assert 'exit-code=1' in output_text
    assert Path(env['INPUT_JSON_PATH']).is_file()
    assert Path(env['INPUT_REPORT_PATH']).is_file()
    assert '| pages (old -> new) | 2 -> 2 |' in summary.read_text(encoding='utf-8')


# --- CI follow-up step ------------------------------------------------------

CI_REORDERED_STEP = 'Diff reordered PDFs with --fail-on reordered'


def _ci_workspace(tmp_path: Path) -> Path:
    """Minimal CI checkout: the repository sidecar plus a scratch artifacts dir."""
    root = tmp_path / 'ci'
    root.mkdir()
    (root / 'sidecar').symlink_to(REPO_ROOT / 'sidecar')
    (root / 'diff-artifacts').mkdir()
    return root


def test_ci_reordered_step_skips_until_the_fixture_exists(tmp_path):
    root = _ci_workspace(tmp_path)

    result = _run_step(
        CI_REORDERED_STEP,
        env={
            'REORDERED_BASELINE': str(root / 'baseline.pdf'),
            'REORDERED_FIXTURE': str(root / 'web-samples' / 'diff-reordered.pdf'),
        },
        cwd=root,
        path=WORKFLOW,
    )

    # G5 has not generated the fixture yet: the step must not fail the build.
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'G5 follow-up' in result.stdout
    assert not (root / 'diff-artifacts' / 'reordered.json').exists()


def test_ci_reordered_step_asserts_the_fixture_when_present(workspace, tmp_path):
    root = _ci_workspace(tmp_path)

    result = _run_step(
        CI_REORDERED_STEP,
        env={
            'REORDERED_BASELINE': workspace['old'],
            'REORDERED_FIXTURE': workspace['new'],
        },
        cwd=root,
        path=WORKFLOW,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    data = json.loads(
        (root / 'diff-artifacts' / 'reordered.json').read_text(encoding='utf-8')
    )
    assert data['summary']['pagesReordered'] > 0

    # A pair without a reordered page must fail the assertion instead of passing.
    failed = _run_step(
        CI_REORDERED_STEP,
        env={
            'REORDERED_BASELINE': workspace['old'],
            'REORDERED_FIXTURE': workspace['old'],
        },
        cwd=root,
        path=WORKFLOW,
    )

    assert failed.returncode == 1, failed.stdout + failed.stderr
    assert 'expected exit 1' in failed.stdout + failed.stderr
