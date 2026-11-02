# PDF diff in CI

`pdf-inspector diff` compares two revisions of a PDF object by object (chars,
words, rects, lines, curves, images, tables), writes deterministic JSON and a
standalone HTML report, and maps the result to a CI exit code.

Two ways to use it in CI:

- **Composite action** (`action.yml`, this repository) - sets up Python, installs
  the sidecar dependencies, runs the diff and fails the step according to
  `fail-on`.
- **Direct CLI** - `python sidecar/cli.py diff ...` when the workflow already has
  Python and the dependencies installed.

Both only read **local file paths**. `http(s)` URLs are rejected on purpose, so a
workflow cannot turn the diff into a network fetch (no SSRF surface).

## Quick start

```yaml
name: PDF diff

on:
  pull_request:
    paths:
      - 'docs/**/*.pdf'

permissions:
  contents: read

jobs:
  pdf-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # The baseline is needed as well: compare against the target branch.
          fetch-depth: 0

      - name: Check out the baseline PDFs
        run: git show origin/${{ github.base_ref }}:docs/report.pdf > baseline.pdf

      - name: Diff report.pdf
        id: diff
        uses: <owner>/pdf-inspector@v1
        with:
          old: baseline.pdf
          new: docs/report.pdf
          fail-on: any
          format: json
          json-path: artifacts/pdf-diff.json
          report-path: artifacts/pdf-diff.html

      - name: Upload the diff reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: pdf-diff
          path: artifacts/
          if-no-files-found: ignore
```

Inside this repository the same job uses `uses: ./` - see the `diff-action` job
in `.github/workflows/ci.yml`.

`fail-on: any` fails the step as soon as anything differs, so the "Upload"
step uses `if: always()` to keep the reports even when the diff fails. If the
diff should be informational only, use `fail-on: none`; the step then exits 0
and the reports can be published as usual.

## Action inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `old` | yes | - | Baseline PDF path, absolute or relative to the workspace. Local file only. |
| `new` | yes | - | Revised PDF path, absolute or relative to the workspace. Local file only. |
| `fail-on` | no | `any` | Difference class that fails the step: `any`, `added`, `removed`, `modified`, `page-count`, `none`. |
| `format` | no | `summary` | Primary output and default artifact format: `summary`, `json`, `html`. JSON/HTML payloads are written to files, not the step log. |
| `json-path` | no | `''` | Where to write the JSON `DiffResult`. Defaults to the runner temp directory when `format: json`. |
| `report-path` | no | `''` | Where to write the standalone HTML report. Defaults to the runner temp directory when `format: html`. |
| `python-version` | no | `3.12` | Python version used to run the CLI. |

Notes:

- Parent directories of `json-path`/`report-path` are created automatically;
  relative paths resolve against the workspace.
- If `json-path`/`report-path` names the artifact of the *other* format (for
  example `format: summary` plus `json-path`), the action runs one extra quiet
  CLI pass so both the log summary and the JSON artifact are produced. Keep
  `format` aligned with the artifact you care about to avoid the extra pass.
- The action installs `sidecar/requirements.txt` on every run, so no Python
  setup step is required in the job. It does not touch the repository working
  tree besides the report paths you ask for.

## Action outputs

| Output | Description |
|---|---|
| `exit-code` | Raw CLI exit code (`0`/`1`/`2`). Always `0` when `fail-on` is `none`. |
| `json-path` | Path of the JSON result written by this run (as given, so relative inputs stay workspace-relative), empty when no JSON was requested or produced. |
| `report-path` | Path of the HTML report written by this run (as given, so relative inputs stay workspace-relative), empty when no HTML was requested or produced. |

The action also appends a short table (exit code, `fail-on`, format, artifact
paths) to `$GITHUB_STEP_SUMMARY`.

```yaml
      - name: Diff report.pdf
        id: diff
        continue-on-error: true
        uses: <owner>/pdf-inspector@v1
        with:
          old: baseline.pdf
          new: docs/report.pdf
          fail-on: any
          format: json
          json-path: artifacts/pdf-diff.json

      - name: Publish the diff summary
        if: steps.diff.outputs.exit-code == '1'
        run: echo "PDF differs - see ${{ steps.diff.outputs.json-path }}"
```

## Exit codes

| Code | Meaning | Action step |
|---|---|---|
| `0` | No difference, or every difference is excluded by `--fail-on`/ignore options. | passes |
| `1` | The `--fail-on` predicate matched. | fails |
| `2` | Usage, input, parsing or output error (missing file, non-PDF input, URL input, bad flag, unwritable report path). | fails |

`fail-on` mapping:

- `any` - any object or page change (the default).
- `added` / `removed` - added/removed objects **and** pages.
- `modified` - modified **and** moved objects.
- `page-count` - page insert/remove, page-count changes and page geometry
  changes (size/rotation).
- `none` - never exits 1; diff errors still exit 2.

Errors are printed to stderr with a one-line `pdf-inspector: ...` prefix so JSON
on stdout is never polluted. Human summaries always go to stdout.

## Artifacts

The CLI writes only the files you ask for:

```text
artifacts/pdf-diff.json    # full DiffResult (schemaVersion 1), stable ordering, no timestamps
artifacts/pdf-diff.html    # self-contained report (inline CSS, escaped text, no external assets)
```

JSON is byte-identical for the same inputs and options, so it can be committed,
diffed, or cached. Typical workflow:

```yaml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: pdf-diff
          path: |
            artifacts/*.json
            artifacts/*.html
```

The sample PDFs produced by `scripts/generate-web-samples.py` land in
`web-samples/` and are only used by the repository CI job; they are not part of
the action.

## Local usage

```sh
# One-time setup: Python 3.10+ and the sidecar dependencies.
python -m venv .venv
.venv/bin/pip install -r sidecar/requirements.txt   # Windows: .venv\Scripts\pip
.venv/bin/pip install reportlab                      # only needed for the samples

# Optional: sample PDFs (web-samples/basic.pdf, web-samples/large.pdf)
python scripts/generate-web-samples.py

# Human summary on stdout, exit code 0/1/2
python sidecar/cli.py diff old.pdf new.pdf --fail-on any

# JSON + HTML reports next to the summary
python sidecar/cli.py diff old.pdf new.pdf \
  --format json --output diff.json --fail-on any
python sidecar/cli.py diff old.pdf new.pdf \
  --format html --output diff.html --fail-on none

# Thresholds / ignores (CLI only; the action exposes fail-on and format)
python sidecar/cli.py diff old.pdf new.pdf \
  --position-tolerance 1.5 \
  --text-tolerance case-insensitive \
  --ignore-types image,char \
  --ignore-fonts --ignore-colors --ignore-images

# Node wrapper (resolves Python, forwards argv and the exit code)
npm run diff -- old.pdf new.pdf --format json --output diff.json
```

`--format summary` (the default) prints the human summary and no payload; the
JSON/HTML payload goes to stdout only when `--format` selects it and `--output`
is omitted, so pipe stdout only when you want machine output.

## Requirements and limitations

- **Python is required.** The CLI and the action need Python 3.10+ with
  `sidecar/requirements.txt` installed (`pdfplumber`, `Pillow`). The action runs
  `actions/setup-python`; for direct CLI use install the dependencies yourself or
  use the repository `.venv`. The packaged desktop app does not ship the CLI.
- **Local paths only.** No URLs, no network access, no secrets. Inputs are
  validated for the `%PDF-` header before parsing; encrypted or corrupt files
  fail with exit code 2 and a readable message.
- **No pixel diff / OCR.** The diff compares extracted objects, not rendered
  pixels, and does not read scanned page images.
- **Private repositories.** The action reads only the files you pass and needs no
  credentials of its own; the job's default `contents: read` token is enough.
  Artifact upload follows the normal `actions/upload-artifact` permissions.
- **Deterministic output.** Same inputs + same options produce the same JSON
  (no timestamps, no absolute paths in the payload), which makes failures easy
  to compare across runs.
