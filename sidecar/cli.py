#!/usr/bin/env python3
"""``pdf-inspector diff`` / ``audit`` / ``audit-dir`` / ``security`` /
``accessibility`` CLI.

The CLI is a thin, dependency-free shell around :func:`sidecar.diff.diff_files`,
:func:`sidecar.audit.audit_file`, :func:`sidecar.audit.security_report`,
:func:`sidecar.audit.accessibility_report`, :func:`sidecar.batch_audit.audit_directory`,
:mod:`sidecar.report`, :mod:`sidecar.audit_report`, :mod:`sidecar.audit_sarif`,
:mod:`sidecar.baseline`, :mod:`sidecar.waivers`, :mod:`sidecar.security_report`
and :mod:`sidecar.accessibility_report`.  Only local inputs are accepted (no
URLs), JSON/HTML/SARIF payloads go to stdout or ``--output``, and every
diagnostic goes to stderr so machine consumers can pipe stdout safely.

``audit`` audits one PDF and keeps baselines, waivers and SARIF; ``audit-dir``
audits every PDF under a local directory and aggregates the per-file reports
(:mod:`sidecar.batch_audit`).  A single unreadable PDF never aborts a directory
audit: it is counted as one failed file and one error, so ``--fail-on error``
still gates it.  Baselines, waivers and SARIF are single-file features and are
not registered on ``audit-dir`` at all rather than silently ignored.  The batch
subcommand renders summary, JSON or one standalone HTML report and can write a
compact ``--stats`` counts artifact for a CI step summary.

Exit codes: ``0`` no failure, ``1`` the ``--fail-on`` predicate matched, ``2``
usage/read/diff/audit/discovery/security/accessibility error.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:  # imported as ``sidecar.cli`` (namespace package)
    from .accessibility_report import (
        format_accessibility_summary,
        render_accessibility_html,
    )
    from .audit import (
        AuditError,
        accessibility_report,
        audit_file,
        security_report,
    )
    from .audit_report import format_audit_summary, render_audit_html
    from .audit_sarif import render_audit_sarif
    from .baseline import BaselineError, compare_reports, load_baseline
    from .batch_audit import (
        DEFAULT_MAX_FILES,
        MAX_FILES_LIMIT,
        PDF_SUFFIX,
        BatchAuditError,
        audit_directory,
    )
    from .batch_report import render_batch_html
    from .diff import DIFF_TYPES, DiffError, DiffOptions, diff_files, tool_version
    from .extractor import PdfExtractor
    from .report import format_summary, page_geometry_changed, render_html
    from .security_report import format_security_summary, render_security_html
    from .waivers import WaiverError, apply_waivers, load_waivers
except ImportError:  # executed as ``python sidecar/cli.py``
    from accessibility_report import (
        format_accessibility_summary,
        render_accessibility_html,
    )
    from audit import (
        AuditError,
        accessibility_report,
        audit_file,
        security_report,
    )
    from audit_report import format_audit_summary, render_audit_html
    from audit_sarif import render_audit_sarif
    from baseline import BaselineError, compare_reports, load_baseline
    from batch_audit import (
        DEFAULT_MAX_FILES,
        MAX_FILES_LIMIT,
        PDF_SUFFIX,
        BatchAuditError,
        audit_directory,
    )
    from batch_report import render_batch_html
    from diff import DIFF_TYPES, DiffError, DiffOptions, diff_files, tool_version
    from extractor import PdfExtractor
    from report import format_summary, page_geometry_changed, render_html
    from security_report import format_security_summary, render_security_html
    from waivers import WaiverError, apply_waivers, load_waivers

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_ERROR = 2

FORMAT_CHOICES = ('summary', 'json', 'html')
# ``audit`` also emits SARIF 2.1.0 for code scanning; ``diff``/``security``/
# ``accessibility`` keep the three report formats.
AUDIT_FORMAT_CHOICES = FORMAT_CHOICES + ('sarif',)
# ``audit-dir`` renders the batch aggregate, which has no SARIF mapping: the
# batch action offers the same three report formats as ``diff``/``security`` and
# ``accessibility`` (summary/json/html).  Keep this tuple the single place the
# subcommand's formats are listed so adding one is a one-line change plus its
# ``_render_audit_dir_payload`` branch.
AUDIT_DIR_FORMAT_CHOICES = ('summary', 'json', 'html')
FAIL_ON_CHOICES = ('any', 'added', 'removed', 'modified', 'page-count', 'reordered', 'none')
AUDIT_FAIL_ON_CHOICES = ('error', 'warning', 'none')
TEXT_TOLERANCE_CHOICES = ('exact', 'normalized', 'case-insensitive')

# Page-level change types that are resources rather than PDF objects.
RESOURCE_CHANGE_TYPES = ('annotation', 'link', 'form')

# A batch summary lists at most this many files before counting the remainder.
MAX_SUMMARY_FILES = 50

# File error text in the batch summary is one bounded line: a damaged PDF must
# never wrap the terminal or push the counts off screen.
MAX_SUMMARY_ERROR_CHARS = 160

# Only the first kilobyte of a PDF may legally contain the header.
_PDF_HEADER_WINDOW = 1024

# Batch summaries print relative paths and per-file error text, both of which can
# originate in a damaged PDF; control bytes must never reach the terminal.
_CONTROL_CHARS = {
    code: None for code in range(0x20) if code not in (0x09, 0x0A, 0x0D)
}
_CONTROL_CHARS.update({0x7F: None, 0x85: None})


class CliError(Exception):
    """A user-facing CLI failure: printed as one line and mapped to exit 2."""


# --- argument parsing -------------------------------------------------------


def _positive_float(value: str) -> float:
    try:
        number = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f'not a number: {value!r}') from exc
    if number < 0 or number != number or number in (float('inf'), float('-inf')):
        raise argparse.ArgumentTypeError(
            f'position tolerance must be a finite non-negative number, got {value!r}'
        )
    return number


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='pdf-inspector',
        description=(
            'Inspect PDF internals, diff two PDF revisions, audit a PDF or a '
            'directory of PDFs, list the document security resources of a PDF and '
            'inspect its tagged accessibility structure.'
        ),
    )
    parser.add_argument(
        '--version',
        action='version',
        version=f'%(prog)s {tool_version()}',
        help='print the tool version and exit',
    )
    subparsers = parser.add_subparsers(dest='command', metavar='command')
    subparsers.required = True

    diff_parser = subparsers.add_parser(
        'diff',
        help='compare two local PDF files',
        description=(
            'Compare two local PDF files object by object and report added, '
            'removed, moved and modified objects plus page-level changes and '
            'the page alignment (match score, reordered page pairs).'
        ),
        epilog=(
            'exit codes: 0 = no failure, 1 = --fail-on matched, 2 = usage/read/diff error. '
            '--fail-on reordered fails when a paired page moved to a different page number. '
            '--ignore-regions PATH reads a JSON array of {oldPage, newPage, bbox} regions '
            '(camelCase, MediaBox-relative PDF points); matching changes are omitted from '
            'the summary, JSON and HTML output. '
            'Diagnostics are written to stderr; JSON on stdout is never polluted.'
        ),
    )
    diff_parser.add_argument('old', metavar='OLD.pdf', help='baseline PDF (local path)')
    diff_parser.add_argument('new', metavar='NEW.pdf', help='revised PDF (local path)')
    diff_parser.add_argument(
        '--format',
        choices=FORMAT_CHOICES,
        default='summary',
        help='output format written to stdout and/or --output (default: summary)',
    )
    diff_parser.add_argument(
        '--output',
        metavar='PATH',
        help='also write the formatted payload to PATH (stdout keeps the summary)',
    )
    diff_parser.add_argument(
        '--fail-on',
        choices=FAIL_ON_CHOICES,
        default='any',
        help=(
            'which difference exits 1 (default: any). "added"/"removed" cover '
            'objects, pages and resources, "modified" covers modified and moved '
            'objects/resources plus document changes (metadata, page labels), '
            '"page-count" covers page insert/remove, page-count and page geometry '
            'changes, "reordered" covers paired pages that moved to a different '
            'page number, "none" never fails'
        ),
    )
    diff_parser.add_argument(
        '--position-tolerance',
        type=_positive_float,
        default=1.0,
        metavar='PT',
        help='movement in PDF points below which objects still match (default: 1.0)',
    )
    diff_parser.add_argument(
        '--text-tolerance',
        choices=TEXT_TOLERANCE_CHOICES,
        default='normalized',
        help='text comparison mode (default: normalized)',
    )
    diff_parser.add_argument(
        '--ignore-types',
        action='append',
        default=[],
        metavar='TYPES',
        help=(
            'comma-separated object types to skip; repeatable '
            f'(valid: {", ".join(DIFF_TYPES)})'
        ),
    )
    diff_parser.add_argument(
        '--ignore-fonts',
        action='store_true',
        help='ignore font name and font size changes',
    )
    diff_parser.add_argument(
        '--ignore-colors',
        action='store_true',
        help='ignore stroke/character colour changes',
    )
    diff_parser.add_argument(
        '--ignore-images',
        action='store_true',
        help='ignore image objects (same as --ignore-types image)',
    )
    diff_parser.add_argument(
        '--ignore-annotations',
        action='store_true',
        help='ignore annotation changes (comments, highlights, markup)',
    )
    diff_parser.add_argument(
        '--ignore-links',
        action='store_true',
        help='ignore link changes (URI targets, internal destinations)',
    )
    diff_parser.add_argument(
        '--ignore-forms',
        action='store_true',
        help='ignore form widget changes (field values, defaults, options)',
    )
    diff_parser.add_argument(
        '--ignore-metadata',
        action='store_true',
        help='ignore document metadata changes (title, author, dates, language)',
    )
    diff_parser.add_argument(
        '--ignore-page-labels',
        action='store_true',
        help='ignore page label (/PageLabels) changes',
    )
    diff_parser.add_argument(
        '--ignore-regions',
        metavar='PATH',
        help=(
            'JSON file with an array of drawn ignore regions (camelCase '
            'oldPage/newPage/bbox, MediaBox-relative PDF points); changes '
            'intersecting a region are not reported'
        ),
    )
    diff_parser.add_argument(
        '--quiet',
        action='store_true',
        help='suppress the human summary on stdout (JSON/HTML payloads are unaffected)',
    )

    audit_parser = subparsers.add_parser(
        'audit',
        help='audit a local PDF file',
        description=(
            'Audit a local PDF for font, page, image, metadata, structure and '
            'security findings and report them as summary, JSON, HTML or SARIF.'
        ),
        epilog=(
            'exit codes: 0 = no threshold matched, 1 = --fail-on matched, '
            '2 = usage/read/audit error. --baseline compares against a previous '
            'report (only new or escalated findings fail); --waivers reads an '
            'expiring waiver policy whose accepted findings never fail and whose '
            'expired entries are reported on stderr. --format sarif emits SARIF '
            '2.1.0 for code scanning and maps --baseline to baselineState and '
            'waivers to suppressions; --sarif-uri sets the artifactLocation.uri '
            '(default: the input argument, so passing a repository-relative path '
            'keeps the payload relative). Diagnostics are written to stderr; '
            'JSON/SARIF on stdout is never polluted.'
        ),
    )
    audit_parser.add_argument('file', metavar='FILE.pdf', help='PDF to audit (local path)')
    audit_parser.add_argument(
        '--format',
        choices=AUDIT_FORMAT_CHOICES,
        default='summary',
        help=(
            'output format written to stdout and/or --output (default: summary); '
            'sarif emits SARIF 2.1.0 for code scanning'
        ),
    )
    audit_parser.add_argument(
        '--output',
        metavar='PATH',
        help='also write the formatted payload to PATH (stdout keeps the summary)',
    )
    audit_parser.add_argument(
        '--baseline',
        metavar='PATH',
        help=(
            'compare against a previous audit report (JSON, local path); only new '
            'or escalated findings count for --fail-on'
        ),
    )
    audit_parser.add_argument(
        '--baseline-output',
        metavar='PATH',
        help=(
            'also write the baseline comparison JSON to PATH '
            '(requires --baseline)'
        ),
    )
    audit_parser.add_argument(
        '--waivers',
        metavar='PATH',
        help=(
            'expiring finding waivers (JSON, local path). Waived findings do not '
            'count for --fail-on; expired waivers are reported and never applied'
        ),
    )
    audit_parser.add_argument(
        '--fail-on',
        choices=AUDIT_FAIL_ON_CHOICES,
        default='none',
        help=(
            'which findings exit 1 (default: none). "warning" fails on warnings '
            'and errors, "error" only on errors, "none" never fails. With '
            '--baseline only new or escalated current findings count'
        ),
    )
    audit_parser.add_argument(
        '--sarif-uri',
        metavar='PATH',
        help=(
            'artifactLocation.uri used by --format sarif (default: the input '
            'argument). Use a repository-relative path for code scanning'
        ),
    )
    audit_parser.add_argument(
        '--quiet',
        action='store_true',
        help=(
            'suppress the human summary on stdout (JSON/HTML/SARIF payloads are '
            'unaffected)'
        ),
    )

    audit_dir_parser = subparsers.add_parser(
        'audit-dir',
        help='audit every PDF file under a local directory',
        description=(
            'Discover the PDF files under a local directory and audit each of '
            'them, continuing past files that cannot be read. The per-file '
            'reports are aggregated into one summary or JSON payload with '
            'stable counts, so a directory can be gated in CI with one command.'
        ),
        epilog=(
            'exit codes: 0 = no threshold matched, 1 = --fail-on matched, '
            '2 = usage/root/discovery/output error. The tree is walked '
            'recursively without following symlinks; hidden entries and '
            'node_modules/.git/.hg/.svn/__pycache__ are skipped, only .pdf files '
            '(case-insensitive) are audited and they are ordered by relative '
            'path. --include/--exclude are fnmatch globs on the relative POSIX '
            'path (several includes are OR-ed, exclude always wins). --max-files '
            f'defaults to {DEFAULT_MAX_FILES} and allows 1..{MAX_FILES_LIMIT}; a '
            'larger tree is an error, never a silent subset. A file that cannot '
            'be read counts as one failed file and one error, so --fail-on error '
            'gates it and the other files are still audited. --format html '
            'renders one self-contained batch report (inline CSS, no scripts). '
            '--stats writes a small JSON counts artifact (schemaVersion, tool, '
            'root and summary only, no findings) for a CI step summary; it is '
            'written for every --format, including summary, and --quiet only '
            'silences the terminal. Baselines, waivers and SARIF are single-file '
            'features and are not available here. Progress goes to stderr; '
            'JSON/HTML on stdout is never polluted.'
        ),
    )
    audit_dir_parser.add_argument(
        'root', metavar='ROOT', help='local directory to audit recursively'
    )
    audit_dir_parser.add_argument(
        '--include',
        action='append',
        default=[],
        metavar='GLOB',
        help=(
            'only audit PDFs whose relative path matches GLOB; repeatable, any '
            'include matches, exclude wins'
        ),
    )
    audit_dir_parser.add_argument(
        '--exclude',
        action='append',
        default=[],
        metavar='GLOB',
        help=(
            'skip PDFs whose relative path matches GLOB; repeatable, overrides '
            'include'
        ),
    )
    audit_dir_parser.add_argument(
        '--max-files',
        type=int,
        default=DEFAULT_MAX_FILES,
        metavar='N',
        help=(
            f'maximum number of PDFs to discover (default: {DEFAULT_MAX_FILES}, '
            f'allowed: 1..{MAX_FILES_LIMIT})'
        ),
    )
    audit_dir_parser.add_argument(
        '--format',
        choices=AUDIT_DIR_FORMAT_CHOICES,
        default='summary',
        help=(
            'output format written to stdout and/or --output (default: summary); '
            'html renders one standalone batch report'
        ),
    )
    audit_dir_parser.add_argument(
        '--output',
        metavar='PATH',
        help='also write the formatted payload to PATH (stdout keeps the summary)',
    )
    audit_dir_parser.add_argument(
        '--stats',
        metavar='PATH',
        help=(
            'also write a small deterministic JSON counts artifact to PATH '
            '(schemaVersion, tool, root and summary only, no findings); written '
            'for every --format, including summary, and --quiet does not '
            'suppress it'
        ),
    )
    audit_dir_parser.add_argument(
        '--fail-on',
        choices=AUDIT_FAIL_ON_CHOICES,
        default='none',
        help=(
            'which aggregated findings exit 1 (default: none). "warning" fails on '
            'warnings and errors, "error" only on errors, "none" never fails. '
            'Failed files count as errors in both modes'
        ),
    )
    audit_dir_parser.add_argument(
        '--quiet',
        action='store_true',
        help=(
            'suppress the progress lines on stderr and the human summary on '
            'stdout (JSON/HTML payloads and --stats are unaffected)'
        ),
    )

    security_parser = subparsers.add_parser(
        'security',
        help='inspect document security resources of a local PDF',
        description=(
            'List embedded attachments, JavaScript previews, actions, signature '
            'fields, XFA, encryption and permissions without executing scripts, '
            'following actions, opening attachments or verifying signatures.'
        ),
        epilog=(
            'exit codes: 0 = no threshold matched, 1 = --fail-on matched, '
            '2 = usage/read/report error. Diagnostics are written to stderr; '
            'JSON on stdout is never polluted.'
        ),
    )
    security_parser.add_argument(
        'file', metavar='FILE.pdf', help='PDF to inspect (local path)'
    )
    security_parser.add_argument(
        '--format',
        choices=FORMAT_CHOICES,
        default='summary',
        help='output format written to stdout and/or --output (default: summary)',
    )
    security_parser.add_argument(
        '--output',
        metavar='PATH',
        help='also write the formatted payload to PATH (stdout keeps the summary)',
    )
    security_parser.add_argument(
        '--fail-on',
        choices=AUDIT_FAIL_ON_CHOICES,
        default='none',
        help=(
            'which security findings exit 1 (default: none). "warning" fails on '
            'warnings and errors, "error" only on errors, "none" never fails'
        ),
    )
    security_parser.add_argument(
        '--quiet',
        action='store_true',
        help='suppress the human summary on stdout (JSON/HTML payloads are unaffected)',
    )

    accessibility_parser = subparsers.add_parser(
        'accessibility',
        help='inspect the tagged structure and accessibility of a local PDF',
        description=(
            'Inspect the tagged structure tree, RoleMap and ParentTree of a local '
            'PDF and report heuristic accessibility findings. No tag is edited, '
            'no content stream is executed and no compliance is certified.'
        ),
        epilog=(
            'exit codes: 0 = no threshold matched, 1 = --fail-on matched, '
            '2 = usage/read/report error. Diagnostics are written to stderr; '
            'JSON on stdout is never polluted.'
        ),
    )
    accessibility_parser.add_argument(
        'file', metavar='FILE.pdf', help='PDF to inspect (local path)'
    )
    accessibility_parser.add_argument(
        '--format',
        choices=FORMAT_CHOICES,
        default='summary',
        help='output format written to stdout and/or --output (default: summary)',
    )
    accessibility_parser.add_argument(
        '--output',
        metavar='PATH',
        help='also write the formatted payload to PATH (stdout keeps the summary)',
    )
    accessibility_parser.add_argument(
        '--fail-on',
        choices=AUDIT_FAIL_ON_CHOICES,
        default='none',
        help=(
            'which accessibility findings exit 1 (default: none). "warning" fails '
            'on warnings and errors, "error" only on errors, "none" never fails'
        ),
    )
    accessibility_parser.add_argument(
        '--quiet',
        action='store_true',
        help='suppress the human summary on stdout (JSON/HTML payloads are unaffected)',
    )
    return parser


# --- helpers ----------------------------------------------------------------


def _one_line(message: Any) -> str:
    return ' '.join(str(message).split())


def _plain_line(value: Any) -> str:
    """One line of plain text with control characters removed.

    Batch entries carry relative paths and per-file error text derived from a
    damaged PDF; an embedded ESC byte must not reach the terminal and a stray
    newline must not break the one-line-per-file layout.  ``None`` renders as an
    empty string rather than ``"None"``, so a payload missing an optional label
    falls through to the caller's ``or`` default.
    """
    if value is None:
        return ''
    return ' '.join(str(value).translate(_CONTROL_CHARS).split())


def _plural(count: int, singular: str, plural: Optional[str] = None) -> str:
    """``1 error`` / ``2 errors``; ``info`` keeps its invariant plural."""
    return f'{count} {singular if count == 1 else (plural or singular + "s")}'


def _bounded(text: str, limit: int = MAX_SUMMARY_ERROR_CHARS) -> str:
    """Truncate one line to ``limit`` characters, marking the cut with ``...``."""
    if len(text) <= limit:
        return text
    return text[: max(limit - 3, 0)].rstrip() + '...'


def _count_field(source: Mapping[str, Any], key: str) -> int:
    """A non-negative counter from a payload mapping; unreadable values are 0."""
    try:
        return max(int(source.get(key) or 0), 0)
    except (AttributeError, TypeError, ValueError):
        return 0


def _config_error(message: Any) -> None:
    sys.stderr.write(f'pdf-inspector: error: {_one_line(message)}\n')
    sys.stderr.flush()


def _load_ignore_regions(path_arg: str) -> list[Any]:
    """Read the ``--ignore-regions`` JSON array (the UI contract's camelCase).

    The file is the same shape the workspace would send over RPC once converted,
    so a user can export/inspect the masks a run used. Parsing errors are CLI
    errors (exit 2); semantic validation is left to ``DiffOptions``.
    """
    path = Path(str(path_arg))
    try:
        text = path.read_text(encoding='utf-8')
    except OSError as exc:
        raise CliError(f'cannot read ignore regions file {path_arg!r}: {exc}') from exc

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CliError(
            f'ignore regions file {path_arg!r} is not valid JSON: {exc}'
        ) from exc

    if not isinstance(data, list):
        raise CliError(
            f'ignore regions file {path_arg!r} must contain a JSON array of regions'
        )
    return data


def _build_options(args: argparse.Namespace) -> DiffOptions:
    ignored: set[str] = set()
    for chunk in args.ignore_types or ():
        for part in str(chunk).split(','):
            part = part.strip().lower()
            if part:
                ignored.add(part)
    regions = _load_ignore_regions(args.ignore_regions) if args.ignore_regions else []
    return DiffOptions(
        position_tolerance=args.position_tolerance,
        text_tolerance=args.text_tolerance,
        ignore_types=ignored,
        ignore_fonts=bool(args.ignore_fonts),
        ignore_colors=bool(args.ignore_colors),
        ignore_images=bool(args.ignore_images),
        ignore_regions=regions,
        ignore_annotations=bool(args.ignore_annotations),
        ignore_links=bool(args.ignore_links),
        ignore_forms=bool(args.ignore_forms),
        ignore_metadata=bool(args.ignore_metadata),
        ignore_page_labels=bool(args.ignore_page_labels),
    )


def _validate_input(path_arg: str, label: str) -> Path:
    """Reject URLs and non-PDF paths before the engine touches them."""
    value = str(path_arg)
    lowered = value.strip().lower()
    if lowered.startswith('http://') or lowered.startswith('https://'):
        raise CliError(
            f'{label} input must be a local file path, not a URL: {value} '
            '(remote inputs are not supported)'
        )

    path = Path(value)
    if not path.exists():
        raise CliError(f'{label} file not found: {value}')
    if not path.is_file():
        raise CliError(f'{label} path is not a file: {value}')

    try:
        with path.open('rb') as handle:
            header = handle.read(_PDF_HEADER_WINDOW)
    except OSError as exc:
        raise CliError(f'cannot read {label} file {value!r}: {exc}') from exc
    if b'%PDF-' not in header:
        raise CliError(f'{label} file is not a PDF (missing %PDF- header): {value}')
    return path


def _validate_root(path_arg: str, label: str = 'root') -> Path:
    """Reject URLs and non-directories before the batch engine discovers files.

    Any ``<scheme>://`` prefix is remote input, matching the rule
    :func:`sidecar.batch_audit.discover_pdfs` applies for itself; a Windows drive
    path (``C:/docs``) has no ``//`` and is unaffected.  The engine re-validates
    the root (it is also used directly), so this check only exists to give the
    CLI its own one-line diagnostic.
    """
    value = str(path_arg)
    lowered = value.strip().lower()
    if '://' in lowered:
        raise CliError(
            f'{label} input must be a local directory path, not a URL: {value} '
            '(remote inputs are not supported)'
        )
    if not lowered:
        raise CliError(f'{label} directory path must not be empty')

    path = Path(value)
    if not path.exists():
        raise CliError(f'{label} directory not found: {value}')
    if not path.is_dir():
        raise CliError(f'{label} path is not a directory: {value}')
    return path


def _render_payload(
    result: Mapping[str, Any],
    output_format: str,
    *,
    old_label: Optional[str] = None,
    new_label: Optional[str] = None,
) -> str:
    if output_format == 'json':
        return json.dumps(result, indent=2, ensure_ascii=False) + '\n'
    if output_format == 'html':
        return render_html(result)
    return format_summary(result, old_label=old_label, new_label=new_label)


def _render_audit_payload(
    report: Mapping[str, Any],
    output_format: str,
    *,
    source_label: Optional[str] = None,
    baseline: Optional[Mapping[str, Any]] = None,
    waivers: Optional[Any] = None,
    sarif_uri: Optional[str] = None,
) -> str:
    """Render one audit payload; JSON stays exactly the ``AuditReport``.

    ``baseline`` and ``waivers`` are only options for the human-facing formats:
    the summary gains one counts line each and the HTML a ``Baseline`` and/or
    ``Waivers`` section.  ``--format json`` never embeds either, which would
    change the ``AuditReport`` contract; the comparison is written by
    ``--baseline-output`` instead.

    ``--format sarif`` maps the same report onto SARIF 2.1.0
    (:mod:`sidecar.audit_sarif`) and does use the comparison and the waiver
    application: they become ``baselineState`` and ``suppressions``, so the SARIF
    a code-scanning consumer stores agrees with the summary the CLI printed.
    ``sarif_uri`` overrides ``artifactLocation.uri``.
    """
    if output_format == 'json':
        return json.dumps(report, indent=2, ensure_ascii=False) + '\n'
    if output_format == 'html':
        return render_audit_html(report, baseline=baseline, waivers=waivers)
    if output_format == 'sarif':
        return render_audit_sarif(
            report,
            source_label,
            baseline,
            waivers,
            uri=sarif_uri,
        )
    return format_audit_summary(
        report, source_label=source_label, baseline=baseline, waivers=waivers
    )


def _render_security_payload(
    report: Mapping[str, Any],
    output_format: str,
    *,
    source_label: Optional[str] = None,
) -> str:
    """Render one security payload; JSON stays exactly the ``SecurityReport``."""
    if output_format == 'json':
        return json.dumps(report, indent=2, ensure_ascii=False) + '\n'
    if output_format == 'html':
        return render_security_html(report, source_label=source_label)
    return format_security_summary(report, source_label=source_label)


def _render_accessibility_payload(
    report: Mapping[str, Any],
    output_format: str,
    *,
    source_label: Optional[str] = None,
) -> str:
    """Render one accessibility payload; JSON is exactly ``AccessibilityReport``."""
    if output_format == 'json':
        return json.dumps(report, indent=2, ensure_ascii=False) + '\n'
    if output_format == 'html':
        return render_accessibility_html(report, source_label=source_label)
    return format_accessibility_summary(report, source_label=source_label)


def format_audit_dir_summary(result: Mapping[str, Any]) -> str:
    """Render the human batch summary printed by ``audit-dir``.

    The text is stable by construction: the tool version, the root's *name*
    (never its location), the aggregate counts and then at most
    :data:`MAX_SUMMARY_FILES` files in discovery order with relative POSIX
    paths.  Every error message is collapsed to one bounded line, so a damaged
    PDF can never print a traceback or wrap the terminal, and no timestamp,
    absolute path or ANSI escape is rendered.

    ``(N total)`` is the sum of the three severity counts on the same line, so
    the arithmetic is checkable by eye; it therefore includes the failed files
    that ``summary.errors`` already counted.  The JSON payload keeps the
    engine's own fields (``summary.findings`` counts findings only), because the
    summary is a human view and the payload is the contract.
    """
    tool = result.get('tool') or {}
    root = result.get('root') or {}
    summary = result.get('summary') or {}
    files = result.get('files') or ()
    errors = _count_field(summary, 'errors')
    warnings = _count_field(summary, 'warnings')
    info = _count_field(summary, 'info')

    lines = [
        f'pdf-inspector {_plain_line(tool.get("version")) or "0.0.0"} '
        '- PDF audit directory',
        f'root: {_plain_line(root.get("name")) or "."}',
        f'files: {_count_field(summary, "files")} '
        f'({_count_field(summary, "audited")} audited, '
        f'{_count_field(summary, "failed")} failed)',
        'findings: '
        f'{_plural(errors, "error")}, '
        f'{_plural(warnings, "warning")}, '
        f'{_plural(info, "info", "info")} '
        f'({_plural(errors + warnings + info, "total", "total")})',
    ]

    entries = [item for item in files if isinstance(item, Mapping)]
    if not entries:
        lines.append('no PDF files found')
        return '\n'.join(lines) + '\n'

    shown = entries[:MAX_SUMMARY_FILES]
    for entry in shown:
        path = _plain_line(entry.get('path')) or '(unknown file)'
        if entry.get('status') == 'ok':
            counts = entry.get('summary')
            counts = counts if isinstance(counts, Mapping) else {}
            detail = (
                f'{_plural(_count_field(counts, "errors"), "error")}, '
                f'{_plural(_count_field(counts, "warnings"), "warning")}'
            )
            lines.append(f'  {"ok":<5} {path}: {detail}')
        else:
            detail = _bounded(_plain_line(entry.get('error')) or 'unknown error')
            lines.append(f'  {"error":<5} {path}: {detail}')
    if len(entries) > len(shown):
        lines.append(f'  ... {len(entries) - len(shown)} more file(s)')
    return '\n'.join(lines) + '\n'


def _render_audit_dir_payload(result: Mapping[str, Any], output_format: str) -> str:
    """Render one batch payload; JSON stays exactly the ``BatchReport``.

    ``AUDIT_DIR_FORMAT_CHOICES`` decides which formats can reach this point.  An
    unregistered format raises instead of falling back to the summary, so adding
    a format to the tuple must add its branch here rather than silently write
    the wrong payload to ``--output``.
    """
    if output_format == 'json':
        return json.dumps(result, indent=2, ensure_ascii=False) + '\n'
    if output_format == 'html':
        return render_batch_html(result)
    if output_format == 'summary':
        return format_audit_dir_summary(result)
    raise ValueError(f'unsupported audit-dir format: {output_format!r}')


def audit_dir_stats(result: Mapping[str, Any]) -> dict[str, Any]:
    """The small counts artifact ``--stats`` writes for a CI step summary.

    Only ``schemaVersion``, ``tool``, ``root`` and ``summary`` are kept: the
    aggregate counts, the root *name* and the tool version are what a workflow
    summary or a dashboard needs, while the per-file findings (and their
    fingerprints) stay in the JSON/HTML payload.  The shape is deterministic --
    fixed keys, fixed order, no timestamp, no absolute path, no file list -- so
    two runs over the same tree serialise byte-identically.

    Counters are coerced to non-negative ints and the root name is flattened to
    one line, because the artifact is also assembled from a damaged directory
    where a name may contain arbitrary bytes.
    """
    tool = result.get('tool')
    tool = tool if isinstance(tool, Mapping) else {}
    root = result.get('root')
    root = root if isinstance(root, Mapping) else {}
    summary = result.get('summary')
    summary = summary if isinstance(summary, Mapping) else {}
    schema_version = _count_field(result, 'schemaVersion') or 1

    return {
        'schemaVersion': schema_version,
        'tool': {
            'name': _plain_line(tool.get('name')) or 'pdf-inspector',
            'version': _plain_line(tool.get('version')) or '0.0.0',
        },
        'root': {
            'name': _plain_line(root.get('name')) or '.',
            'files': _count_field(root, 'files'),
            'bytes': _count_field(root, 'bytes'),
        },
        'summary': {
            key: _count_field(summary, key)
            for key in (
                'files',
                'audited',
                'failed',
                'findings',
                'errors',
                'warnings',
                'info',
            )
        },
    }


def security_file(path: Any) -> dict[str, Any]:
    """Open a local PDF and return its complete ``SecurityReport``.

    The security engine reads pdfminer objects, so it only needs to open the
    document; it never extracts pages.  Open errors are reported as
    :class:`AuditError`, which the CLI maps to exit code 2.
    """
    target = path if isinstance(path, Path) else Path(str(path))
    extractor = None
    try:
        extractor = PdfExtractor(str(target))
    except Exception as exc:
        raise AuditError(f'Cannot open PDF {str(target)!r}: {exc}') from exc

    try:
        return security_report(extractor)
    finally:
        if extractor is not None:
            try:
                extractor.close()
            except Exception:
                # Closing is best effort: never mask the real report or error.
                pass


def accessibility_file(path: Any) -> dict[str, Any]:
    """Open a local PDF and return its complete ``AccessibilityReport``.

    The accessibility engine reads catalog/structure objects and never extracts
    page text, so it only needs an open document.  Open errors are reported as
    :class:`AuditError`, which the CLI maps to exit code 2.
    """
    target = path if isinstance(path, Path) else Path(str(path))
    extractor = None
    try:
        extractor = PdfExtractor(str(target))
    except Exception as exc:
        raise AuditError(f'Cannot open PDF {str(target)!r}: {exc}') from exc

    try:
        return accessibility_report(extractor)
    finally:
        if extractor is not None:
            try:
                extractor.close()
            except Exception:
                # Closing is best effort: never mask the real report or error.
                pass


def _write_output(path_arg: str, payload: str) -> None:
    path = Path(path_arg)
    if path.exists() and path.is_dir():
        raise CliError(f'output path is a directory, not a file: {path_arg}')
    parent = path.parent
    if parent and not parent.exists():
        raise CliError(f'output directory does not exist: {parent}')
    try:
        with path.open('w', encoding='utf-8', newline='\n') as handle:
            handle.write(payload)
    except OSError as exc:
        raise CliError(f'cannot write output file {path_arg!r}: {exc}') from exc
    except UnicodeError as exc:
        # Payloads are UTF-8 text.  Every engine sanitises the values it reports,
        # so this is a last resort: a lone surrogate here must be a one-line user
        # error instead of a traceback and a misleadingly empty artifact.
        raise CliError(
            f'cannot encode output file {path_arg!r} as UTF-8: {exc}'
        ) from exc


def _reject_input_overwrite(path_arg: str, input_paths: Sequence[Path]) -> None:
    """Refuse ``--output`` paths that would destroy one of the compared PDFs."""
    try:
        resolved = Path(path_arg).resolve()
    except OSError:  # pragma: no cover - defensive, resolve rarely raises
        return
    for input_path in input_paths:
        try:
            if resolved == input_path.resolve():
                raise CliError(
                    f'output path must not overwrite an input PDF: {path_arg}'
                )
        except OSError:  # pragma: no cover - defensive
            continue


def _same_path(first: Path, second: Path) -> bool:
    """True when two paths resolve to the same file (best effort)."""
    try:
        return first.resolve() == second.resolve()
    except OSError:  # pragma: no cover - defensive, resolve rarely raises
        return False


def _reject_audit_dir_overwrite(path_arg: str, root: Path) -> None:
    """Refuse an ``--output``/``--stats`` path that would replace an audited PDF.

    The batch payload is relative to ``root`` and the tree is read-only, so no
    artifact may land on an audited file.  The check uses the resolved path, so
    ``sub/../a.pdf`` and a symlinked location are caught as well as the literal
    spelling; only ``.pdf`` targets (case-insensitive, the suffix discovery
    keeps) are refused, because any other file inside the tree is not audited.
    """
    try:
        resolved = Path(str(path_arg)).resolve()
        resolved_root = root.resolve()
    except OSError:  # pragma: no cover - defensive, resolve rarely raises
        return

    if resolved == resolved_root:
        raise CliError(
            f'output path must not overwrite the audit root directory: {path_arg}'
        )
    try:
        relative = resolved.relative_to(resolved_root)
    except ValueError:
        return
    if relative.suffix.lower() == PDF_SUFFIX:
        raise CliError(
            f'output path must not overwrite a PDF under the audit root: {path_arg}'
        )


def _moved_resource_count(result: Mapping[str, Any]) -> int:
    """Page-level resource changes reported as ``moved``.

    ``summary`` counts added/removed/modified resources only, so a moved
    annotation/link/form has to be read from the page change lists. Metadata and
    page labels never appear in a page list; they are counted by
    ``summary.documentChanges``.
    """
    total = 0
    for page in result.get('pages') or ():
        if not isinstance(page, Mapping):
            continue
        for change in page.get('changes') or ():
            if (
                isinstance(change, Mapping)
                and change.get('kind') == 'moved'
                and change.get('type') in RESOURCE_CHANGE_TYPES
            ):
                total += 1
    return total


def failure_reason(result: Mapping[str, Any], fail_on: str) -> Optional[str]:
    """Return a one-line reason when ``fail_on`` matches, else ``None``.

    ``added``/``removed`` count pages, objects and resources; ``modified``
    covers modified/moved objects, modified/moved resources and document
    changes (metadata and page labels); ``page-count`` covers page insert/remove,
    page-count and page geometry changes; ``reordered`` covers paired pages
    reported at a different ordinal position (``summary.pagesReordered``).
    """
    if fail_on == 'none':
        return None
    if fail_on not in FAIL_ON_CHOICES:
        raise ValueError(f'unknown fail-on mode: {fail_on!r}')

    summary = result.get('summary') or {}
    old = result.get('old') or {}
    new = result.get('new') or {}

    def count(key: str) -> int:
        try:
            return int(summary.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    pages_added = count('pagesAdded')
    pages_removed = count('pagesRemoved')
    pages_changed = count('pagesChanged')
    pages_reordered = count('pagesReordered')
    objects_added = count('objectsAdded')
    objects_removed = count('objectsRemoved')
    objects_moved = count('objectsMoved')
    objects_modified = count('objectsModified')
    resources_added = count('resourcesAdded')
    resources_removed = count('resourcesRemoved')
    resources_modified = count('resourcesModified')
    # A moved resource is not in the summary counters; a synthetic result may
    # also omit the counter while still carrying the list.
    if summary.get('documentChanges') is None:
        listed_changes = result.get('documentChanges')
        if isinstance(listed_changes, Sequence) and not isinstance(
            listed_changes, (str, bytes)
        ):
            document_changes = len(listed_changes)
        else:
            document_changes = 0
    else:
        document_changes = count('documentChanges')
    # A moved resource is in the summary counter when the engine emitted it;
    # synthetic/older payloads only carry the page change lists. Read exactly one
    # source so a move is never counted twice.
    if summary.get('resourcesMoved') is None:
        resources_moved = _moved_resource_count(result)
    else:
        resources_moved = count('resourcesMoved')

    if fail_on == 'any':
        object_total = objects_added + objects_removed + objects_moved + objects_modified
        page_total = pages_added + pages_removed + pages_changed
        resource_total = (
            resources_added + resources_removed + resources_modified + resources_moved
        )
        if object_total or page_total or resource_total or document_changes:
            if not (resource_total or document_changes):
                # Legacy message for an object/page-only run.
                return (
                    f'{object_total} object change(s) and {page_total} page change(s) '
                    'detected (fail-on any)'
                )
            return (
                f'{object_total} object change(s), {page_total} page change(s), '
                f'{resource_total} resource change(s) and {document_changes} document '
                'change(s) detected (fail-on any)'
            )
    elif fail_on == 'added':
        if pages_added or objects_added or resources_added:
            reason = f'{pages_added} page(s) and {objects_added} object(s) added'
            if resources_added:
                reason += f' plus {resources_added} resource(s) added'
            return reason + ' (fail-on added)'
    elif fail_on == 'removed':
        if pages_removed or objects_removed or resources_removed:
            reason = f'{pages_removed} page(s) and {objects_removed} object(s) removed'
            if resources_removed:
                reason += f' plus {resources_removed} resource(s) removed'
            return reason + ' (fail-on removed)'
    elif fail_on == 'modified':
        if (
            objects_modified
            or objects_moved
            or resources_modified
            or resources_moved
            or document_changes
        ):
            reason = f'{objects_modified} object(s) modified and {objects_moved} moved'
            extras = []
            resource_total = resources_modified + resources_moved
            if resource_total:
                extras.append(f'{resource_total} resource(s) modified/moved')
            if document_changes:
                extras.append(f'{document_changes} document change(s)')
            if extras:
                reason += ' plus ' + ' and '.join(extras)
            return reason + ' (fail-on modified)'
    elif fail_on == 'page-count':
        try:
            old_pages = int(old.get('pages') or 0)
        except (TypeError, ValueError):
            old_pages = 0
        try:
            new_pages = int(new.get('pages') or 0)
        except (TypeError, ValueError):
            new_pages = 0
        geometry = page_geometry_changed(result)
        if old_pages != new_pages or pages_added or pages_removed or geometry:
            return (
                f'page count/geometry changed ({old_pages} -> {new_pages}) '
                '(fail-on page-count)'
            )
    elif fail_on == 'reordered':
        if pages_reordered:
            return (
                f'{pages_reordered} page pair(s) at a different page number '
                '(fail-on reordered)'
            )
    return None


def audit_failure_reason(
    report: Mapping[str, Any],
    fail_on: str,
    comparison: Optional[Mapping[str, Any]] = None,
    waivers: Optional[Any] = None,
) -> Optional[str]:
    """Return a one-line reason when ``fail_on`` matches, else ``None``.

    ``warning`` covers warnings and errors, ``error`` only errors, and ``none``
    never fails.  Without ``comparison`` the counts come from the report
    summary, so the pre-baseline behaviour is unchanged.  With a comparison only
    current findings whose status is ``new`` or ``escalated`` count: ``existing``
    and ``moved`` are history, ``fixed`` is no longer present, and ``waived``
    is accepted by policy.

    ``waivers`` is an optional waiver application.  With a comparison the
    waived findings are already excluded (their status is ``waived``), so it is
    only consulted for the no-baseline case, where the waived findings are
    subtracted from the report counts: an accepted error never trips
    ``--fail-on error``.  Without waivers the counts stay exactly the summary's.
    """
    if fail_on == 'none':
        return None
    if fail_on not in AUDIT_FAIL_ON_CHOICES:
        raise ValueError(f'unknown audit fail-on mode: {fail_on!r}')

    if isinstance(comparison, Mapping):
        errors, warnings = _comparison_severity_counts(comparison)
        if fail_on == 'error' and errors:
            return (
                f'{errors} new or escalated audit error(s) found '
                '(fail-on error)'
            )
        if fail_on == 'warning' and (errors or warnings):
            return (
                f'{errors} new or escalated audit error(s) and {warnings} new or '
                'escalated warning(s) found (fail-on warning)'
            )
        return None

    applied = _waived_indices(waivers)
    if applied:
        errors, warnings = _unwaived_severity_counts(report, applied)
    else:
        summary = report.get('summary') or {}

        def count(key: str) -> int:
            try:
                return int(summary.get(key) or 0)
            except (TypeError, ValueError):
                return 0

        errors = count('errors')
        warnings = count('warnings')

    if fail_on == 'error' and errors:
        return f'{errors} audit error(s) found (fail-on error)'
    if fail_on == 'warning' and (errors or warnings):
        return (
            f'{errors} audit error(s) and {warnings} warning(s) found '
            '(fail-on warning)'
        )
    return None


def _waived_indices(waivers: Any) -> frozenset[int]:
    """Indices of current findings accepted by a waiver application."""
    if waivers is None:
        return frozenset()
    applied = (
        waivers.get('applied')
        if isinstance(waivers, Mapping)
        else getattr(waivers, 'applied', None)
    )
    if not isinstance(applied, Mapping):
        return frozenset()
    return frozenset(
        index
        for index in applied
        if isinstance(index, int) and not isinstance(index, bool)
    )


def _unwaived_severity_counts(
    report: Mapping[str, Any], waived: frozenset[int]
) -> tuple[int, int]:
    """Errors and warnings among the findings no waiver accepted."""
    errors = 0
    warnings = 0
    findings = report.get('findings') or ()
    if not isinstance(findings, Sequence) or isinstance(findings, (str, bytes)):
        return errors, warnings
    for index, finding in enumerate(findings):
        if index in waived or not isinstance(finding, Mapping):
            continue
        severity = finding.get('severity')
        if severity == 'error':
            errors += 1
        elif severity == 'warning':
            warnings += 1
    return errors, warnings


def _comparison_severity_counts(
    comparison: Mapping[str, Any],
) -> tuple[int, int]:
    """Errors and warnings among current findings with status new/escalated."""
    errors = 0
    warnings = 0
    for entry in comparison.get('findings') or ():
        if not isinstance(entry, Mapping):
            continue
        if entry.get('status') not in ('new', 'escalated'):
            continue
        finding = entry.get('current')
        if not isinstance(finding, Mapping):
            continue
        severity = finding.get('severity')
        if severity == 'error':
            errors += 1
        elif severity == 'warning':
            warnings += 1
    return errors, warnings


def security_failure_reason(report: Mapping[str, Any], fail_on: str) -> Optional[str]:
    """Return a one-line reason when ``fail_on`` matches, else ``None``.

    ``warning`` covers warnings and errors, ``error`` only errors, and ``none``
    never fails.  Counts come from the security report summary, so a report
    without findings never trips a threshold.
    """
    if fail_on == 'none':
        return None
    if fail_on not in AUDIT_FAIL_ON_CHOICES:
        raise ValueError(f'unknown security fail-on mode: {fail_on!r}')

    summary = report.get('summary') or {}

    def count(key: str) -> int:
        try:
            return int(summary.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    errors = count('errors')
    warnings = count('warnings')

    if fail_on == 'error' and errors:
        return f'{errors} security error(s) found (fail-on error)'
    if fail_on == 'warning' and (errors or warnings):
        return (
            f'{errors} security error(s) and {warnings} warning(s) found '
            '(fail-on warning)'
        )
    return None


def accessibility_failure_reason(
    report: Mapping[str, Any], fail_on: str
) -> Optional[str]:
    """Return a one-line reason when ``fail_on`` matches, else ``None``.

    ``warning`` covers warnings and errors, ``error`` only errors, and ``none``
    never fails.  Counts come from the accessibility report summary, so a
    report without findings never trips a threshold.
    """
    if fail_on == 'none':
        return None
    if fail_on not in AUDIT_FAIL_ON_CHOICES:
        raise ValueError(f'unknown accessibility fail-on mode: {fail_on!r}')

    summary = report.get('summary') or {}

    def count(key: str) -> int:
        try:
            return int(summary.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    errors = count('errors')
    warnings = count('warnings')

    if fail_on == 'error' and errors:
        return f'{errors} accessibility error(s) found (fail-on error)'
    if fail_on == 'warning' and (errors or warnings):
        return (
            f'{errors} accessibility error(s) and {warnings} warning(s) found '
            '(fail-on warning)'
        )
    return None


def audit_dir_failure_reason(
    result: Mapping[str, Any], fail_on: str
) -> Optional[str]:
    """Return a one-line reason when ``fail_on`` matches, else ``None``.

    The counts are the batch aggregate's, so every decision uses the numbers the
    summary and JSON already report: ``warning`` covers warnings and errors,
    ``error`` only errors, and ``none`` never fails.  ``summary.errors`` includes
    the failed files (:mod:`sidecar.batch_audit` adds them), which is why a
    damaged PDF trips ``--fail-on error`` even when every other file is clean.
    """
    if fail_on == 'none':
        return None
    if fail_on not in AUDIT_FAIL_ON_CHOICES:
        raise ValueError(f'unknown audit dir fail-on mode: {fail_on!r}')

    summary = result.get('summary')
    summary = summary if isinstance(summary, Mapping) else {}
    errors = _count_field(summary, 'errors')
    warnings = _count_field(summary, 'warnings')
    failed = _count_field(summary, 'failed')
    failed_note = f' including {failed} failed file(s)' if failed else ''

    if fail_on == 'error' and errors:
        return f'{errors} audit error(s){failed_note} found (fail-on error)'
    if fail_on == 'warning' and (errors or warnings):
        return (
            f'{errors} audit error(s){failed_note} and {warnings} warning(s) '
            'found (fail-on warning)'
        )
    return None


# --- command ----------------------------------------------------------------


def _run_audit(args: argparse.Namespace) -> int:
    # ``--sarif-uri`` only means something for the SARIF payload; failing here
    # keeps a mixed invocation from silently ignoring the option.
    if args.sarif_uri is not None:
        if args.format != 'sarif':
            raise CliError('--sarif-uri requires --format sarif')
        if not str(args.sarif_uri).strip():
            raise CliError('--sarif-uri must not be empty')

    input_path = _validate_input(args.file, 'audit')
    baseline_path = Path(str(args.baseline)) if args.baseline is not None else None
    waiver_path = Path(str(args.waivers)) if args.waivers is not None else None
    if args.baseline_output is not None and baseline_path is None:
        raise CliError('--baseline-output requires --baseline')

    if args.output is not None:
        _reject_input_overwrite(args.output, (input_path,))
        if baseline_path is not None and _same_path(Path(args.output), baseline_path):
            raise CliError(
                f'output path must not overwrite the baseline file: {args.output}'
            )
        if waiver_path is not None and _same_path(Path(args.output), waiver_path):
            raise CliError(
                f'output path must not overwrite the waivers file: {args.output}'
            )
    if args.baseline_output is not None:
        _reject_input_overwrite(args.baseline_output, (input_path,))
        if baseline_path is not None and _same_path(
            Path(args.baseline_output), baseline_path
        ):
            raise CliError(
                'comparison output path must not overwrite the baseline file: '
                f'{args.baseline_output}'
            )
        if waiver_path is not None and _same_path(
            Path(args.baseline_output), waiver_path
        ):
            raise CliError(
                'comparison output path must not overwrite the waivers file: '
                f'{args.baseline_output}'
            )
    if (
        args.output is not None
        and args.baseline_output is not None
        and _same_path(Path(args.output), Path(args.baseline_output))
    ):
        raise CliError(
            'output path and comparison output path must be different files: '
            f'{args.output}'
        )

    # Validate the baseline and the waiver policy before the audit so a bad
    # file fails fast, before any PDF is opened.
    baseline_report = (
        load_baseline(args.baseline) if args.baseline is not None else None
    )
    waiver_policy = load_waivers(args.waivers) if args.waivers is not None else None

    report = audit_file(input_path)
    waiver_application = (
        apply_waivers(report.get('findings') or (), waiver_policy)
        if waiver_policy is not None
        else None
    )
    comparison = (
        compare_reports(report, baseline_report, waiver_application)
        if baseline_report is not None
        else None
    )

    payload = _render_audit_payload(
        report,
        args.format,
        source_label=str(args.file),
        baseline=comparison,
        waivers=waiver_application,
        sarif_uri=args.sarif_uri,
    )

    if args.output is not None:
        _write_output(args.output, payload)
    if args.baseline_output is not None and comparison is not None:
        _write_output(
            args.baseline_output,
            json.dumps(comparison, indent=2, ensure_ascii=False) + '\n',
        )

    if args.format == 'summary' or args.output is not None:
        # Human summaries are never mixed into machine payloads on stdout.
        if not args.quiet:
            summary = (
                payload
                if args.format == 'summary'
                else format_audit_summary(
                    report,
                    source_label=str(args.file),
                    baseline=comparison,
                    waivers=waiver_application,
                )
            )
            sys.stdout.write(summary)
    else:
        sys.stdout.write(payload)
    sys.stdout.flush()

    if waiver_application is not None and waiver_application.expired:
        # Policy diagnostics are not part of the human summary: --quiet only
        # silences stdout, so an expired waiver still gets one stderr line.
        count = waiver_application.expired_count
        sys.stderr.write(
            f'pdf-inspector: {count} waiver(s) expired and were not applied\n'
        )
        sys.stderr.flush()

    reason = audit_failure_reason(report, args.fail_on, comparison, waiver_application)
    if reason is not None:
        sys.stderr.write(f'pdf-inspector: {reason}\n')
        sys.stderr.flush()
        return EXIT_FAIL
    return EXIT_OK


def _audit_dir_progress(done: int, total: int, path: str) -> None:
    """``audit-dir: [2/5] reports/b.pdf`` -- batch progress belongs on stderr.

    The engine calls this before auditing each file with the number already
    completed, so the printed ordinal is the file currently being processed.
    The path is flattened like every other batch line: a file name may legally
    contain a control byte, and a progress line must stay one line.
    """
    sys.stderr.write(f'audit-dir: [{done + 1}/{total}] {_plain_line(path)}\n')
    sys.stderr.flush()


def _run_audit_dir(args: argparse.Namespace) -> int:
    root = _validate_root(args.root)
    if args.output is not None:
        _reject_audit_dir_overwrite(args.output, root)
    # ``--stats`` is an artifact of its own: it must not overwrite a PDF under
    # the root (the tree is read-only for this command) nor the payload file.
    if args.stats is not None:
        if not str(args.stats).strip():
            raise CliError('--stats path must not be empty')
        _reject_audit_dir_overwrite(args.stats, root)
        if args.output is not None and _same_path(
            Path(args.stats), Path(args.output)
        ):
            raise CliError(
                'output path and stats path must be different files: '
                f'{args.stats}'
            )

    result = audit_directory(
        root,
        include=tuple(args.include or ()),
        exclude=tuple(args.exclude or ()),
        max_files=args.max_files,
        # ``--quiet`` asks for payload only: no progress, no human summary, but
        # errors still reach stderr through ``main``.
        progress=None if args.quiet else _audit_dir_progress,
    )

    payload = _render_audit_dir_payload(result, args.format)
    if args.output is not None:
        _write_output(args.output, payload)
    if args.stats is not None:
        # Written for every format, including summary, and regardless of
        # ``--quiet``: the CI step summary reads this file, not stdout.
        _write_output(
            args.stats,
            json.dumps(audit_dir_stats(result), indent=2, ensure_ascii=False) + '\n',
        )

    if args.format == 'summary' or args.output is not None:
        # Human summaries are never mixed into machine payloads on stdout.
        if not args.quiet:
            summary = (
                payload
                if args.format == 'summary'
                else format_audit_dir_summary(result)
            )
            sys.stdout.write(summary)
    else:
        sys.stdout.write(payload)
    sys.stdout.flush()

    reason = audit_dir_failure_reason(result, args.fail_on)
    if reason is not None:
        sys.stderr.write(f'pdf-inspector: {reason}\n')
        sys.stderr.flush()
        return EXIT_FAIL
    return EXIT_OK


def _run_security(args: argparse.Namespace) -> int:
    input_path = _validate_input(args.file, 'security')
    if args.output is not None:
        _reject_input_overwrite(args.output, (input_path,))

    report = security_file(input_path)
    payload = _render_security_payload(
        report,
        args.format,
        source_label=str(args.file),
    )

    if args.output is not None:
        _write_output(args.output, payload)

    if args.format == 'summary' or args.output is not None:
        # Human summaries are never mixed into machine payloads on stdout.
        if not args.quiet:
            summary = (
                payload
                if args.format == 'summary'
                else format_security_summary(report, source_label=str(args.file))
            )
            sys.stdout.write(summary)
    else:
        sys.stdout.write(payload)
    sys.stdout.flush()

    reason = security_failure_reason(report, args.fail_on)
    if reason is not None:
        sys.stderr.write(f'pdf-inspector: {reason}\n')
        sys.stderr.flush()
        return EXIT_FAIL
    return EXIT_OK


def _run_accessibility(args: argparse.Namespace) -> int:
    input_path = _validate_input(args.file, 'accessibility')
    if args.output is not None:
        _reject_input_overwrite(args.output, (input_path,))

    report = accessibility_file(input_path)
    payload = _render_accessibility_payload(
        report,
        args.format,
        source_label=str(args.file),
    )

    if args.output is not None:
        _write_output(args.output, payload)

    if args.format == 'summary' or args.output is not None:
        # Human summaries are never mixed into machine payloads on stdout.
        if not args.quiet:
            summary = (
                payload
                if args.format == 'summary'
                else format_accessibility_summary(
                    report, source_label=str(args.file)
                )
            )
            sys.stdout.write(summary)
    else:
        sys.stdout.write(payload)
    sys.stdout.flush()

    reason = accessibility_failure_reason(report, args.fail_on)
    if reason is not None:
        sys.stderr.write(f'pdf-inspector: {reason}\n')
        sys.stderr.flush()
        return EXIT_FAIL
    return EXIT_OK


def _run_diff(args: argparse.Namespace) -> int:
    old_path = _validate_input(args.old, 'old')
    new_path = _validate_input(args.new, 'new')
    if args.output is not None:
        _reject_input_overwrite(args.output, (old_path, new_path))
    options = _build_options(args)

    result = diff_files(old_path, new_path, options)

    payload = _render_payload(
        result,
        args.format,
        old_label=str(args.old),
        new_label=str(args.new),
    )

    if args.output is not None:
        _write_output(args.output, payload)

    if args.format == 'summary' or args.output is not None:
        # Human summaries are never mixed into machine payloads on stdout.
        if not args.quiet:
            summary = (
                payload
                if args.format == 'summary'
                else format_summary(result, old_label=str(args.old), new_label=str(args.new))
            )
            sys.stdout.write(summary)
    else:
        sys.stdout.write(payload)
    sys.stdout.flush()

    reason = failure_reason(result, args.fail_on)
    if reason is not None:
        sys.stderr.write(f'pdf-inspector: {reason}\n')
        sys.stderr.flush()
        return EXIT_FAIL
    return EXIT_OK


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == 'diff':
            return _run_diff(args)
        if args.command == 'audit':
            return _run_audit(args)
        if args.command == 'audit-dir':
            return _run_audit_dir(args)
        if args.command == 'security':
            return _run_security(args)
        if args.command == 'accessibility':
            return _run_accessibility(args)
        parser.error(f'unknown command: {args.command}')
    except (
        CliError,
        DiffError,
        AuditError,
        BaselineError,
        BatchAuditError,
        WaiverError,
        ValueError,
    ) as exc:
        _config_error(exc)
        return EXIT_ERROR
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except Exception:
            pass
        return EXIT_OK
    except KeyboardInterrupt:
        sys.stderr.write('pdf-inspector: interrupted\n')
        sys.stderr.flush()
        return 130
    return EXIT_OK


if __name__ == '__main__':
    sys.exit(main())
