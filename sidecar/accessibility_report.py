"""Plain-text and standalone HTML rendering for ``AccessibilityReport`` dictionaries.

Both renderers are pure string builders: no external assets, no JavaScript, no
timestamps and no absolute paths of their own.  Every user-controlled value
(document title/language, structure roles, Alt/ActualText, finding text) passes
through :func:`html.escape`, so PDF text such as ``<script>`` can never become
markup, and identical ``AccessibilityReport`` input renders byte-identical
output (CI artifact friendly).

``format_accessibility_summary`` is the human text the CLI prints; it shows the
document facts, the structure counts, the severity counts and at most
``MAX_SUMMARY_FINDINGS`` findings ordered severity-first (error, warning, info)
before truncating, so errors/warnings are never hidden behind later ``info``
findings.  Report order is preserved inside each severity, so the summary stays
deterministic.  ``render_accessibility_html`` is the single-file report written
by ``--format html``; it lists every finding in report order.

The optional source label is reduced to its final path component (and escaped)
so a report never embeds a local directory or an absolute path.

The checks behind the findings are heuristics (see ``sidecar/audit.py``); the
rendered report never claims PDF/UA or WCAG conformance.
"""

from __future__ import annotations

import html
from pathlib import PurePath
from typing import Any, Mapping, Sequence

# Findings listed in the plain-text summary before the rest is counted.
MAX_SUMMARY_FINDINGS = 20

NO_FINDINGS_TEXT = 'findings: none - no accessibility findings'

# Fixed severity order, so the summary never depends on dict iteration order.
SEVERITY_FIELDS = (
    ('errors', 'error'),
    ('warnings', 'warning'),
    ('info', 'info'),
)

# Summary truncation order: errors first, then warnings, then info.
# Unknown severities sort last; the sort is stable, so report order survives.
SEVERITY_ORDER = {'error': 0, 'warning': 1, 'info': 2}

# Content placeholders, counted separately from structure elements.
CONTENT_KINDS = ('mcid', 'object')

_CSS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 20px;
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #1f2430;
  background: #f6f7f9;
}
main {
  max-width: 1040px;
  margin: 0 auto;
  padding: 28px 32px 36px;
  background: #ffffff;
  border: 1px solid #dde1e8;
  border-radius: 10px;
}
h1 { margin: 0 0 4px; font-size: 24px; }
h2 { margin: 32px 0 12px; padding-bottom: 6px; font-size: 18px; border-bottom: 1px solid #e4e8ef; }
h3 { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 6px; font-size: 15px; }
p, dl, table { margin: 0 0 12px; }
.meta, .muted { color: #5b6472; font-size: 13px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; text-align: left; vertical-align: top; border: 1px solid #e1e5ec; }
th { background: #f2f4f8; font-weight: 600; }
table.info-table th { width: 200px; }
td.num { text-align: right; white-space: nowrap; }
caption { padding-bottom: 6px; text-align: left; font-weight: 600; caption-side: top; }
code, .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 12px; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.badge-error { background: #fde8e8; color: #a02121; }
.badge-warning { background: #fdeedd; color: #9a4b06; }
.badge-info { background: #e7effd; color: #1f4fa8; }
.badge-unknown { background: #eef0f4; color: #4a5261; }
ol.findings { list-style: none; margin: 0; padding: 0; }
li.finding { margin: 0 0 16px; padding: 14px 16px; background: #fbfcfe; border: 1px solid #e1e5ec; border-left-width: 4px; border-radius: 8px; }
li.finding-error { border-left-color: #a02121; }
li.finding-warning { border-left-color: #c2710d; }
li.finding-info { border-left-color: #1f4fa8; }
li.finding-unknown { border-left-color: #8a92a1; }
li.finding dl { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 4px 16px; margin: 0; }
li.finding dt { font-weight: 600; color: #3b4351; }
li.finding dd { margin: 0; }
.empty { color: #5b6472; font-style: italic; }
footer { margin-top: 32px; padding-top: 12px; color: #6b7280; font-size: 12px; border-top: 1px solid #e4e8ef; }
""".strip()


# --- small helpers ----------------------------------------------------------


_CONTROL_CHARS = {
    code: None for code in range(0x20) if code not in (0x09, 0x0A, 0x0D)
}
_CONTROL_CHARS.update({0x7F: None, 0x85: None})


def _text(value: Any) -> str:
    return '' if value is None else str(value)


def _plain(value: Any) -> str:
    """One line of plain text: no control characters, so no ANSI escapes.

    Document titles, roles and finding text are user data; an embedded ESC byte
    must not reach the terminal, and a stray newline must not break the
    one-line-per-finding layout of the summary.
    """
    return ' '.join(_text(value).translate(_CONTROL_CHARS).split())


def _esc(value: Any) -> str:
    return html.escape(_text(value), quote=True)


def _fmt_int(value: Any) -> int:
    """Coerce a count to a non-negative int; unreadable values count as 0."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(number, 0)


def _yes_no(value: Any) -> str:
    return 'yes' if value else 'no'


def _source_label(value: Any) -> str:
    """The final path component of an optional label (never an absolute path)."""
    text = _plain(value)
    if not text:
        return ''
    # Accept POSIX and Windows separators without touching the filesystem.
    name = PurePath(text.replace('\\', '/')).name
    return name or text


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _entries(report: Mapping[str, Any], key: str) -> list[Mapping[str, Any]]:
    value = report.get(key)
    if not isinstance(value, (list, tuple)):
        return []
    return [entry for entry in value if isinstance(entry, Mapping)]


def _counts(report: Mapping[str, Any]) -> dict[str, int]:
    """Severity counts from ``summary``, recomputed when it is missing."""
    findings = _entries(report, 'findings')
    summary = report.get('summary')
    if isinstance(summary, Mapping):
        counts = {field: _fmt_int(summary.get(field)) for field, _ in SEVERITY_FIELDS}
        counts['total'] = _fmt_int(summary.get('total')) or sum(counts.values())
        return counts

    counts = {field: 0 for field, _ in SEVERITY_FIELDS}
    for finding in findings:
        severity = _plain(finding.get('severity'))
        for field, name in SEVERITY_FIELDS:
            if severity == name:
                counts[field] += 1
                break
    counts['total'] = len(findings)
    return counts


def _severity_rank(finding: Mapping[str, Any]) -> int:
    return SEVERITY_ORDER.get(_plain(finding.get('severity')), len(SEVERITY_ORDER))


def prioritize_findings(
    findings: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Order findings for the summary: errors, then warnings, then info.

    The sort is stable and only re-orders whole severities, so the report's own
    order is preserved inside each severity and the result stays deterministic.
    """
    return sorted(findings, key=_severity_rank)


def _is_heading(role: str) -> bool:
    """``H1``..``H9`` (standard roles stop at H6; unreadable extras still count)."""
    return len(role) > 1 and role[0] == 'H' and role[1:].isdigit()


def structure_counts(report: Mapping[str, Any]) -> dict[str, int]:
    """Count structure elements by kind from the bounded structure forest.

    The walk is iterative and cycle-safe so a malformed synthetic report can
    never hang the renderer; the parser already bounds real documents.
    """
    counts = {
        'elements': 0,
        'figures': 0,
        'tables': 0,
        'lists': 0,
        'headings': 0,
        'contents': 0,
    }
    stack: list[Any] = list(report.get('structure') or ())
    seen: set[int] = set()
    while stack:
        node = stack.pop()
        if not isinstance(node, Mapping):
            continue
        identity = id(node)
        if identity in seen:
            continue
        seen.add(identity)

        kind = _plain(node.get('kind'))
        role = _plain(node.get('role'))
        if kind in CONTENT_KINDS or (not kind and role in ('MCID', 'OBJR')):
            counts['contents'] += 1
        else:
            counts['elements'] += 1
            if role == 'Figure':
                counts['figures'] += 1
            elif role == 'Table':
                counts['tables'] += 1
            elif role == 'L':
                counts['lists'] += 1
            elif _is_heading(role):
                counts['headings'] += 1

        children = node.get('children')
        if isinstance(children, (list, tuple)):
            stack.extend(children)
    return counts


def _finding_location(finding: Mapping[str, Any]) -> str:
    """``structure, page 2`` or just the category for document-level findings."""
    category = _plain(finding.get('category')) or 'structure'
    page = finding.get('page')
    try:
        page_number = None if page is None else int(page)
    except (TypeError, ValueError):
        page_number = None
    return f'{category}, page {page_number}' if page_number is not None else category


def _document_facts(document: Mapping[str, Any]) -> str:
    language = _plain(document.get('language')) or 'none'
    version = _plain(document.get('version')) or 'unknown'
    return (
        f'{_fmt_int(document.get("pages"))} page(s), version {version}, '
        f'encrypted: {_yes_no(document.get("encrypted"))}, '
        f'tagged: {_yes_no(document.get("tagged"))}, language: {language}'
    )


def _structure_facts(counts: Mapping[str, int]) -> str:
    return (
        f'elements {counts["elements"]}, figures {counts["figures"]}, '
        f'tables {counts["tables"]}, lists {counts["lists"]}, '
        f'headings {counts["headings"]}'
    )


def _tree_facts(document: Mapping[str, Any]) -> str:
    return (
        f'StructTreeRoot {_yes_no(document.get("hasStructTreeRoot"))}, '
        f'ParentTree {_yes_no(document.get("hasParentTree"))}, '
        f'truncated {_yes_no(document.get("truncated"))}, '
        f'skipped {_fmt_int(document.get("skipped"))}'
    )


# --- plain-text summary -----------------------------------------------------


def format_accessibility_summary(
    report: Mapping[str, Any],
    source_label: Any = None,
    *,
    max_findings: int = MAX_SUMMARY_FINDINGS,
) -> str:
    """Render the human accessibility summary printed by the CLI.

    The text is stable (report order within a severity, no timestamps, no ANSI
    escapes, no absolute paths) and always carries the document facts, the
    structure counts, the severity counts and the first ``max_findings``
    findings after a severity-first sort; the remainder is reported as a count.
    """
    report = report if isinstance(report, Mapping) else {}
    tool = _mapping(report.get('tool'))
    version = _plain(tool.get('version')) or '0.0.0'
    document = _mapping(report.get('document'))
    findings = _entries(report, 'findings')
    counts = _counts(report)
    structure = structure_counts(report)

    lines = [f'pdf-inspector {version} - PDF accessibility']
    label = _source_label(source_label)
    if label:
        lines.append(f'file: {label}')
    lines.append(f'document: {_document_facts(document)}')
    lines.append(f'structure: {_structure_facts(structure)}')
    lines.append(f'tree: {_tree_facts(document)}')
    title = _plain(document.get('title'))
    if title:
        lines.append(f'title: {title}')
    lines.append(
        f'summary: {counts["errors"]} errors, {counts["warnings"]} warnings, '
        f'{counts["info"]} info ({counts["total"]} total)'
    )

    if not findings:
        lines.append(NO_FINDINGS_TEXT)
        return '\n'.join(lines) + '\n'

    try:
        limit = max(int(max_findings), 0)
    except (TypeError, ValueError):  # pragma: no cover - defensive
        limit = MAX_SUMMARY_FINDINGS
    ordered = prioritize_findings(findings)
    shown = ordered[:limit]
    lines.append(f'findings: {len(ordered)} total, showing {len(shown)}')
    for index, finding in enumerate(shown, start=1):
        severity = _plain(finding.get('severity')) or 'unknown'
        finding_title = _plain(finding.get('title')) or '(untitled finding)'
        lines.append(
            f'  {index}. [{severity}] {_finding_location(finding)}: {finding_title}'
        )
    if len(ordered) > len(shown):
        lines.append(f'  ... {len(ordered) - len(shown)} more finding(s)')
    return '\n'.join(lines) + '\n'


# --- HTML report ------------------------------------------------------------


def _badge(severity: Any) -> str:
    value = _text(severity) or 'unknown'
    css_kind = value if value in ('error', 'warning', 'info') else 'unknown'
    return f'<span class="badge badge-{css_kind}">{_esc(value)}</span>'


def _cell(value: Any, *, mono: bool = False) -> str:
    if value is None or _text(value).strip() == '':
        return '<span class="muted">&mdash;</span>'
    css = ' class="mono"' if mono else ''
    return f'<span{css}>{_esc(value)}</span>'


def _row(label: str, value: Any) -> str:
    return f'<tr><th scope="row">{_esc(label)}</th><td>{_cell(value)}</td></tr>'


def _num_row(label: str, value: Any) -> str:
    return (
        f'<tr><th scope="row">{_esc(label)}</th>'
        f'<td class="num">{_fmt_int(value)}</td></tr>'
    )


def _render_document_section(document: Mapping[str, Any]) -> str:
    role_map = document.get('roleMap')
    role_map_entries = len(role_map) if isinstance(role_map, Mapping) else 0
    rows = [
        _row('Pages', _fmt_int(document.get('pages'))),
        _row('PDF version', _plain(document.get('version')) or 'unknown'),
        _row('Encrypted', _yes_no(document.get('encrypted'))),
        _row('Tagged', _yes_no(document.get('tagged'))),
        _row('StructTreeRoot', _yes_no(document.get('hasStructTreeRoot'))),
        _row('ParentTree', _yes_no(document.get('hasParentTree'))),
        _row('Language', document.get('language')),
        _row('Title', document.get('title')),
        _row('Structure tree truncated', _yes_no(document.get('truncated'))),
        _row('Skipped elements', _fmt_int(document.get('skipped'))),
        _row('RoleMap entries', role_map_entries),
    ]
    return ''.join(
        [
            '<section id="document">',
            '<h2>Document</h2>',
            '<table class="info-table">',
            '<caption>Document information</caption>',
            '<tbody>',
            *rows,
            '</tbody>',
            '</table>',
            '</section>',
        ]
    )


def _render_summary_section(report: Mapping[str, Any]) -> str:
    counts = _counts(report)
    structure = structure_counts(report)
    structure_rows = [
        _num_row('Structure elements', structure['elements']),
        _num_row('Figures', structure['figures']),
        _num_row('Tables', structure['tables']),
        _num_row('Lists', structure['lists']),
        _num_row('Headings', structure['headings']),
        _num_row('MCID/OBJR content items', structure['contents']),
    ]
    severity_rows = [
        _num_row(label, counts[field])
        for field, label in (
            ('errors', 'Errors'),
            ('warnings', 'Warnings'),
            ('info', 'Info'),
            ('total', 'Total'),
        )
    ]
    return ''.join(
        [
            '<section id="summary">',
            '<h2>Summary</h2>',
            '<table class="count-table">',
            '<caption>Structure counts</caption>',
            '<tbody>',
            *structure_rows,
            '</tbody>',
            '</table>',
            '<table class="summary-table">',
            '<caption>Findings by severity</caption>',
            '<thead><tr><th>Severity</th><th>Count</th></tr></thead>',
            '<tbody>',
            *severity_rows,
            '</tbody>',
            '</table>',
            '</section>',
        ]
    )


def _render_detail_rows(finding: Mapping[str, Any]) -> str:
    rows = []
    evidence = finding.get('evidence')
    if evidence is not None and _text(evidence).strip():
        rows.append(f'<dt>Evidence</dt><dd class="mono">{_esc(evidence)}</dd>')
    recommendation = finding.get('recommendation')
    if recommendation is not None and _text(recommendation).strip():
        rows.append(f'<dt>Recommendation</dt><dd>{_esc(recommendation)}</dd>')
    if not rows:
        return ''
    return f'<dl class="details">{"".join(rows)}</dl>'


def _render_finding(finding: Mapping[str, Any], position: int) -> str:
    severity = _plain(finding.get('severity')) or 'unknown'
    css_kind = severity if severity in ('error', 'warning', 'info') else 'unknown'
    title = _plain(finding.get('title')) or '(untitled finding)'
    detail = finding.get('detail')

    parts = [
        f'<li class="finding finding-{css_kind}" id="finding-{position}">',
        f'<h3>{_esc(title)} {_badge(severity)}</h3>',
        f'<p class="meta">{_esc(_finding_location(finding))}</p>',
    ]
    if detail is not None and _text(detail).strip():
        parts.append(f'<p>{_esc(detail)}</p>')
    parts.append(_render_detail_rows(finding))
    parts.append('</li>')
    return ''.join(parts)


def _render_findings_section(findings: Sequence[Mapping[str, Any]]) -> str:
    parts = [
        '<section id="findings">',
        '<h2>Accessibility findings</h2>',
        f'<p class="muted">{len(findings)} finding(s)</p>',
    ]
    if findings:
        parts.append('<ol class="findings">')
        for position, finding in enumerate(findings, start=1):
            parts.append(_render_finding(finding, position))
        parts.append('</ol>')
    else:
        parts.append('<p class="empty">No accessibility findings.</p>')
    parts.append('</section>')
    return ''.join(parts)


def render_accessibility_html(
    report: Mapping[str, Any],
    source_label: Any = None,
) -> str:
    """Render a full, self-contained HTML accessibility report.

    The report uses inline CSS only: no scripts, no external assets and no
    links, so it opens safely offline and renders identically everywhere.
    """
    report = report if isinstance(report, Mapping) else {}
    tool = _mapping(report.get('tool'))
    version = _plain(tool.get('version')) or '0.0.0'
    schema_version = _plain(report.get('schemaVersion')) or '1'
    document = _mapping(report.get('document'))
    findings = _entries(report, 'findings')

    meta = f'pdf-inspector {_esc(version)} &middot; schema {_esc(schema_version)}'
    label = _source_label(source_label)
    if label:
        meta += f' &middot; file {_esc(label)}'

    lines = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f'<title>PDF accessibility report - pdf-inspector {_esc(version)}</title>',
        '<style>',
        _CSS,
        '</style>',
        '</head>',
        '<body>',
        '<main>',
        '<header>',
        '<h1>PDF accessibility report</h1>',
        f'<p class="meta">{meta}</p>',
        '</header>',
        _render_document_section(document),
        _render_summary_section(report),
        _render_findings_section(findings),
        '<footer>',
        f'Generated by pdf-inspector {_esc(version)}. '
        'Deterministic report: no timestamps, no absolute paths, no external '
        'assets, no scripts. The checks are heuristic and do not certify '
        'PDF/UA or WCAG conformance; no content stream is executed.',
        '</footer>',
        '</main>',
        '</body>',
        '</html>',
    ]
    return '\n'.join(lines) + '\n'


__all__ = [
    'MAX_SUMMARY_FINDINGS',
    'NO_FINDINGS_TEXT',
    'SEVERITY_FIELDS',
    'SEVERITY_ORDER',
    'format_accessibility_summary',
    'prioritize_findings',
    'render_accessibility_html',
    'structure_counts',
]
