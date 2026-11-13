# PDF diff and audit quality gates in CI

Two read-only CLIs can gate a pipeline:

- `pdf-inspector diff` compares two revisions of a PDF object by object (chars,
  words, rects, lines, curves, images, tables) plus document resources,
  writes deterministic JSON and a standalone HTML report, and maps the result
  to a CI exit code.
- `pdf-inspector audit` checks one PDF for font, page, image, metadata,
  structure and security findings. Its baseline, expiring waivers and SARIF
  output turn a one-shot report into an incremental gate that only fails on new
  or escalated problems.

Both are documented here; the audit checks and the `AuditReport` /
`BaselineComparison` schemas live in [docs/audit.md](audit.md), and the diff
object model in [docs/diff.md](diff.md).

Two ways to run either CLI in CI:

- **Composite actions** - `action.yml` (diff, this repository) and
  `audit/action.yml` (audit). They set up Python, install the sidecar
  dependencies, run the CLI and fail the step according to `fail-on`.
- **Direct CLI** - `python sidecar/cli.py diff ...` or
  `python sidecar/cli.py audit ...` when the workflow already has Python and
  the dependencies installed.

All of them only read **local file paths**. `http(s)` URLs are rejected on
purpose, so a workflow cannot turn either command into a network fetch (no SSRF
surface).

## Quick start: diff

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

## Diff action inputs

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

## Diff action outputs

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

## Diff exit codes

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

## Diff artifacts

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

## Local diff usage

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

## Audit quality gates and SARIF

`pdf-inspector audit` reports font, page, image, metadata, structure and security
findings for one local PDF. It supports four formats - `summary`, `json`, `html`
and `sarif` - and four ways to gate a pipeline. Pick one row as the primary
policy; the options combine (a baseline plus waivers plus SARIF is valid).

| Approach | Flags / inputs | Fails the step on | Use when |
|---|---|---|---|
| No baseline (strict) | `--fail-on error` / `--fail-on warning` | every current finding of that severity | the PDF is new, or the repository is already clean |
| Baseline file (incremental) | `--baseline report.json --fail-on warning` (plus `--baseline-output` / `baseline-output-path`) | only `new` and `escalated` findings | adopting the gate where older PDFs already have findings |
| SARIF code scanning | `--format sarif` (+ `--sarif-uri`) and `github/codeql-action/upload-sarif` | nothing by itself; alerts live in the Security tab, and `--fail-on` still decides the step | reviewers need per-finding alerts and PR annotations, with GitHub keeping the alert history |
| Waivers (accepted exceptions) | `--waivers waivers.json` (`waivers-path`), with or without a baseline | every finding no valid waiver accepts | a known problem is tracked elsewhere and must expire on a date |

All four read the same `AuditReport`, so the counts in the step log, the JSON
artifact, the HTML report and the SARIF payload always describe the same run.
The status vocabulary (`new` / `existing` / `moved` / `escalated` / `fixed` /
`waived`) and the exact exit-code rules are documented in
[docs/audit.md](audit.md).

### Audit action inputs

| Input | Default | Description |
|---|---|---|
| `path` | - | PDF path, absolute or relative to the workspace. Local file only. |
| `fail-on` | `error` | `error`, `warning` or `none`; only `new`/`escalated` findings count when `baseline-path` is set. |
| `format` | `summary` | `summary`, `json`, `html` or `sarif`. |
| `json-path` / `report-path` / `sarif-path` | `''` | Where to write the JSON `AuditReport`, the HTML report and the SARIF payload. Each defaults to the runner temp directory when it is the primary `format`. |
| `baseline-path` | `''` | Previous `AuditReport` (JSON, i.e. the `audit --format json` output) to compare against. Local file only; a missing file or a URL fails the step with exit code 2. |
| `baseline-output-path` | `''` | Where to write the `BaselineComparison` JSON (requires `baseline-path`). Must differ from `json-path`, `report-path` and `sarif-path`. |
| `waivers-path` | `''` | Expiring waiver policy (JSON). Accepted findings do not fail the step. |
| `sarif-uri` | `''` | `artifactLocation.uri` of the SARIF payload. Only valid with `format: sarif`. |
| `python-version` | `3.12` | Python version used to run the CLI. |

`baseline-path` must point at an `AuditReport`, not at a `BaselineComparison`:
passing the `--baseline-output` artifact back in is rejected with exit code 2
(its finding entries carry `status`/`current`/`baseline`, so it is not a report).
`baseline-output-path` is the only input for the comparison artifact; naming the
same file as `json-path`, `report-path` or `sarif-path` fails the
input-validation step, because one write would silently replace the other.

Outputs: `exit-code` (raw `0`/`1`/`2`), `json-path`, `report-path` and
`sarif-path`. The step summary lists the exit code, the threshold, the format and
the baseline, waiver and artifact paths. A missing or `http(s)` baseline/waiver
path fails the input-validation step before Python is installed, so no payload is
written for a run that never happened. See [docs/audit.md](audit.md) for the full
input/output tables.

### Code scanning workflow

```yaml
name: PDF audit

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  pdf-audit:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # required by upload-sarif only
    steps:
      - uses: actions/checkout@v4

      - name: Audit docs/report.pdf
        id: audit
        # Keep going so the SARIF payload is uploaded even when the gate fails;
        # the last step turns the exit code back into a failure.
        continue-on-error: true
        uses: <owner>/pdf-inspector/audit@v1
        with:
          path: docs/report.pdf
          fail-on: warning
          format: sarif
          sarif-path: artifacts/audit.sarif
          # Repository-relative path: code scanning resolves the uri against
          # the checkout, so no absolute workspace path ends up in the payload.
          sarif-uri: docs/report.pdf
          # Optional: compare against a committed report (see below).
          baseline-path: ci/pdf-audit-baseline.json
          baseline-output-path: artifacts/audit-comparison.json
          # Optional: expiring policy for accepted findings.
          waivers-path: ci/pdf-audit-waivers.json

      - name: Upload SARIF to code scanning
        if: always() && steps.audit.outputs.sarif-path != ''
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ${{ steps.audit.outputs.sarif-path }}
          category: pdf-inspector-audit

      - name: Enforce the audit gate
        if: steps.audit.outputs.exit-code != '0'
        run: exit '${{ steps.audit.outputs.exit-code }}'
```

Private repositories that cannot use code scanning can still consume the file:
`--format sarif --output audit.sarif` writes plain SARIF 2.1.0 that any SARIF
viewer accepts.

### Direct CLI (no action)

```sh
# Plain SARIF on stdout (relative input keeps the uri relative)
python sidecar/cli.py audit docs/report.pdf --format sarif --fail-on none

# SARIF file plus the human summary on stdout
python sidecar/cli.py audit docs/report.pdf \
  --format sarif --output audit.sarif --sarif-uri docs/report.pdf \
  --fail-on warning

# Baseline-relative gate: only new or escalated findings fail
python sidecar/cli.py audit docs/report.pdf \
  --format json --output audit-current.json \
  --baseline ci/pdf-audit-baseline.json \
  --baseline-output artifacts/audit-comparison.json \
  --fail-on warning
```

`--sarif-uri` is only valid together with `--format sarif`; combining it with
`json`/`html`/`summary` is a usage error (exit code 2, one
`pdf-inspector: error: ...` line), because a silently ignored option would
produce a payload whose paths the caller did not intend.

Two more usage rules apply to the artifacts:

- `--baseline` takes the `AuditReport` from `audit --format json`. Feeding it a
  `BaselineComparison` (the `--baseline-output` artifact) exits 2: the file has
  the same `schemaVersion`, but its finding entries carry
  `status`/`current`/`baseline`, so it is not a report.
- `--output` and `--baseline-output` must name different files (exit 2), and
  neither may overwrite the input PDF, the baseline file, or the waiver file.

### What the SARIF payload contains

- One run, `$schema` `https://json.schemastore.org/sarif-2.1.0.json`,
  `version` `2.1.0`, `columnKind` `utf16CodeUnits`.
- `tool.driver` = `pdf-inspector` plus the CLI version and
  `informationUri`. `rules` is de-duplicated by `ruleId` and sorted, so the array
  is independent of report order; `ruleIndex` always points into it.
- `ruleId` = `pdf-inspector/<category>/<slug(title)>`. The slug keeps lowercase
  ASCII letters and digits, turns every other run into `-`, caps at 64
  characters and falls back to `finding`. Two different titles that collapse onto
  the same slug both gain `-<first 8 hex of sha256(title)>`, so one check never
  hides another.
- `level`: `error` -> `error`, `warning` -> `warning`, `info` -> `note`.
  `message.text` is `title: detail` (just `title` when there is no detail).
- `locations[0].physicalLocation.artifactLocation.uri` is `--sarif-uri` when
  given, otherwise the input argument as passed (backslashes become `/`). A
  page-level finding adds `region.startPage`; a document-level finding (no page)
  has no `locations` at all, so it is not pinned to an arbitrary page.
- `partialFingerprints["pdfInspectorFinding/v1"]` is the finding fingerprint: a
  hash of category, title, detail and evidence only, after references to the
  finding's own page are normalized (`Page 3` / `page 3` become `Page #` /
  `page #` when the finding is on page 3; other page numbers in the same text are
  hashed verbatim, and `p. 3`, `PAGE 3`, `Pages 3` are not normalized). Moving a
  page-scoped finding to another page therefore keeps its identity when the
  hashed text names only its own page - it becomes `moved` and does not fail
  `--fail-on` - while raising its severity keeps the same alert and a genuinely
  new page finding is `new`. Aggregate findings that list several pages in
  `evidence` (for example structure-tree issues) still become `new` + `fixed`
  when the whole document shifts. Code scanning keeps the same alert instead of
  opening a duplicate.
- With `--baseline`, `baselineState` is `new` for new/escalated findings and
  `unchanged` for existing/moved ones; fixed findings are not emitted at all.
- With `--waivers`, accepted findings carry
  `suppressions: [{kind: "external", status: "accepted", justification: <reason>}]`
  and no `baselineState`; code scanning shows them as dismissed with the policy
  reason attached.
- No timestamps, hostnames or tool-generated absolute paths: two runs over the
  same input and options are byte-identical, so the file can be committed, cached
  or diffed.

### Baseline vs. code-scanning baseline

The two baselines are independent and answer different questions:

- **`--baseline` (this tool)** compares the current report with an
  `AuditReport` JSON *you* supply (committed, or downloaded from the target
  branch). It is what `--fail-on` counts, so a repository with existing warnings
  can adopt the gate without rewriting them first: the step only fails on
  `new`/`escalated` findings. It is deterministic and identical on every machine.
  Because references to a finding's own page are normalized before hashing, a
  problem that only moved to another page is `moved` rather than `new` +
  `fixed`, and it does not fail the gate.
- **GitHub code scanning** keeps its own alert history for the branch
  (`ref`/`category`) and decides what is "new in this PR". `upload-sarif` never
  reads our baseline file, and SARIF `baselineState` is informational to it.

Practical consequence: a finding marked `baselineState: new` in the payload is
new relative to *your* baseline file, while code scanning may still show it as an
existing alert (or vice versa). Committing the baseline makes the *gate*
reproducible; code scanning decides the *presentation*. Regenerate the baseline
after upgrading pdf-inspector or after intentionally changing wording in a
finding title/detail, because the fingerprint hashes those fields. The same
applies to page references: only `Page N` / `page N` pointing at the finding's
own page are normalized, so wording such as `p. 3`, `PAGE 3` or `Pages 3` makes
the identity page-dependent again.

### Waivers

A waiver file is a reviewed policy, not an ignore list:

```json
{
  "schemaVersion": 1,
  "waivers": [
    {
      "fingerprint": "0123456789abcdef0123456789abcdef",
      "page": 7,
      "reason": "Legacy template; tracked in DOC-1234",
      "expires": "2026-12-31"
    }
  ]
}
```

- `reason` and `expires` are mandatory; `page` is optional (any page when
  omitted).
- `expires` is inclusive: the waiver still suppresses on that date and stops the
  day after, which is reported once on stderr. That notice is a policy
  diagnostic: `--quiet` only suppresses the human summary, so the line is
  printed even in a quiet run. Exit code 2 is not used - an expired waiver is a
  policy signal, not a usage error.
- The fingerprint comes from `--format json` (`findings[].fingerprint`) - no
  hashing on the CI side.
- A waiver that no longer matches any finding is counted as `unused` so it can be
  removed. Review waiver additions like code.

Do not use waivers or baselines to hide a genuinely new finding: the fingerprint
covers the finding text, so an edited finding is a new finding and needs a new
waiver. Local paths of the baseline and waiver files never appear in the JSON,
HTML or SARIF payloads - only the policy facts (status, reason, expiry date).

### Limits

The audit is heuristic: it reads PDF objects, fonts, metadata, page geometry and
the tag tree, and it never certifies PDF/A or PDF/UA compliance. SARIF upload,
baselines and waivers only change how findings are reported and gated, not what
the audit detects. No network access, no pixel diff, no OCR, no PDF modification.

## Requirements and limitations

- **Python is required.** The CLI and the action need Python 3.10+ with
  `sidecar/requirements.txt` installed (`pdfplumber`, `Pillow`). The action runs
  `actions/setup-python`; for direct CLI use install the dependencies yourself or
  use the repository `.venv`. The packaged desktop app does not ship the CLI.
- **Local paths only.** No URLs, no network access, no secrets. Inputs are
  validated for the `%PDF-` header before parsing; encrypted or corrupt files
  fail with exit code 2 and a readable message.
- **No pixel diff / OCR.** The diff compares extracted objects, not rendered
  pixels, and does not read scanned page images. The audit is heuristic in the
  same way and never certifies PDF/A or PDF/UA compliance.
- **Private repositories.** Both actions read only the files you pass and need no
  credentials of their own; the job's default `contents: read` token is enough.
  Artifact upload follows the normal `actions/upload-artifact` permissions, and
  SARIF upload additionally needs `security-events: write`.
- **Deterministic output.** Same inputs + same options produce the same JSON,
  HTML, SARIF and `BaselineComparison` payloads (no timestamps, no absolute paths
  in the payload), which makes failures easy to compare across runs.
