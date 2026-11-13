"""Compare an :class:`~sidecar.audit.AuditReport` against a previous one.

The comparison is a pure function over the report dicts: it reads no PDF, makes
no network request, and never writes a timestamp or an absolute path.  Findings
are matched by their stable ``fingerprint`` (see
:func:`sidecar.audit.finding_fingerprint`) using a multiset, so two identical
findings on the same page are paired one-to-one instead of collapsing.

Status rules, applied per fingerprint group:

1. current and baseline findings on the same page pair as ``existing``;
2. the remaining same-fingerprint findings pair in page order as ``moved``
   (the problem is the same, only its page changed);
3. unmatched current findings are ``new`` and unmatched baseline findings are
   ``fixed``;
4. a paired finding whose severity rank rose (``info`` < ``warning`` <
   ``error``) becomes ``escalated``, overriding ``existing`` and ``moved``;
5. a current finding accepted by an expiring waiver (see
   :mod:`sidecar.waivers`) becomes ``waived``, overriding every status above.

The result is the ``BaselineComparison`` contract: ``schemaVersion`` 1, the
tool block of the current report, page/finding counts for both sides, the
status counts, the waiver counters (only when waivers were loaded) and one
entry per current finding (report order) followed by one entry per fixed
baseline finding (baseline order).  Each entry carries the full current and
baseline finding so a consumer can render it without re-reading either report;
a ``waived`` entry also carries the ``waiver`` reason and expiry date.

The summary always carries the ``waived`` key (``0`` without waivers) so
consumers can rely on the shape, and adding ``waiver_application=None`` keeps
the output byte-identical to the pre-waiver comparison.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping, Optional, Union

try:  # imported as ``sidecar.baseline`` (namespace package)
    from .audit import (
        AUDIT_CATEGORIES,
        AUDIT_SEVERITIES,
        FINGERPRINT_KEY,
        finding_fingerprint,
        tool as audit_tool,
    )
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from audit import (
        AUDIT_CATEGORIES,
        AUDIT_SEVERITIES,
        FINGERPRINT_KEY,
        finding_fingerprint,
        tool as audit_tool,
    )


BASELINE_SCHEMA_VERSION = 1

# Status order used by the comparison summary (and by the report renderers).
BASELINE_STATUSES = ('new', 'existing', 'moved', 'escalated', 'fixed', 'waived')

# Keys that only a ``BaselineComparison`` finding entry carries.  A file with
# them is the ``--baseline-output`` artifact, not an ``AuditReport``.
COMPARISON_ONLY_KEYS = ('status', 'current', 'baseline')

# Top-level keys that only a ``BaselineComparison`` carries.  An ``AuditReport``
# has ``document``/``summary``/``findings`` instead, so even an empty comparison
# (``findings: []``) is still identified by these keys.
COMPARISON_TOP_LEVEL_KEYS = ('current', 'baseline')

# A fingerprint is the engine's truncated SHA-256: exactly 32 lowercase hex.
FINGERPRINT_PATTERN = re.compile(r'\A[0-9a-f]{32}\Z')

# Severity ranks: a strict increase is an escalation.  Unknown severities rank
# as ``info`` so a malformed report cannot manufacture an escalation.
SEVERITY_RANK = {'info': 0, 'warning': 1, 'error': 2}


class BaselineError(ValueError):
    """A baseline input that cannot be read or is not an ``AuditReport``.

    Subclasses :class:`ValueError` so the CLI and the RPC layer report it as a
    user error (one message, never a traceback) through their existing paths.
    """


# --- loading ----------------------------------------------------------------


def load_baseline(path: Union[str, Path]) -> dict[str, Any]:
    """Read and validate a baseline report from a local JSON file.

    Only local files are accepted (no URLs).  The file must be an
    ``AuditReport``-like object: a JSON object with ``schemaVersion`` 1 and a
    ``findings`` array of finding-shaped objects (category, severity, page,
    title, detail, evidence, recommendation).  A ``BaselineComparison`` written
    by ``--baseline-output`` is rejected with a clear error instead of being
    compared as if it were a report.

    Findings written before fingerprints existed get one computed with the same
    engine function, so a legacy report compares correctly; a fingerprint that
    is present must be exactly 32 lowercase hex characters.  The input object is
    copied; the caller's data is never mutated.
    """
    label = str(path)
    lowered = label.strip().lower()
    # ``Path('https://...')`` collapses the double slash to ``https:/...``, so
    # this also rejects a URL that a caller already wrapped in ``Path``.
    if lowered.startswith(('http:/', 'https:/')):
        raise BaselineError(
            f'baseline input must be a local file path, not a URL: {label} '
            '(remote inputs are not supported)'
        )

    target = Path(label)
    try:
        text = target.read_text(encoding='utf-8')
    except OSError as exc:
        raise BaselineError(f'cannot read baseline file {label!r}: {exc}') from exc

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise BaselineError(
            f'baseline file {label!r} is not valid JSON: {exc}'
        ) from exc

    return _validated_report(data, label)


def _validated_report(data: Any, label: str) -> dict[str, Any]:
    """Validate one parsed baseline object and fill in missing fingerprints."""
    if not isinstance(data, Mapping):
        raise BaselineError(
            f'baseline file {label!r} must contain a JSON object with '
            'schemaVersion 1 and a findings array'
        )

    schema = data.get('schemaVersion')
    if isinstance(schema, bool) or not isinstance(schema, int) or schema != 1:
        raise BaselineError(
            f'baseline file {label!r} must have schemaVersion 1, got {schema!r}'
        )

    comparison_keys = [key for key in COMPARISON_TOP_LEVEL_KEYS if key in data]
    if comparison_keys:
        # A comparison with no findings still has these blocks; without this
        # check it would be accepted as an empty baseline and mark every
        # current finding new.
        raise BaselineError(
            f'baseline file {label!r} looks like a BaselineComparison '
            f'(top-level key(s): {", ".join(comparison_keys)}); pass the '
            'original AuditReport JSON, not the --baseline-output comparison'
        )

    findings = data.get('findings')
    if not isinstance(findings, list):
        raise BaselineError(
            f'baseline file {label!r} must contain a findings array'
        )

    normalized: list[dict[str, Any]] = []
    for position, finding in enumerate(findings, start=1):
        normalized.append(_validated_finding(finding, position, label))

    report = dict(data)
    report['findings'] = normalized
    return report


def _validated_finding(finding: Any, position: int, label: str) -> dict[str, Any]:
    """Validate one baseline finding and return a copy with a fingerprint."""
    where = f'baseline file {label!r} finding {position}'
    if not isinstance(finding, Mapping):
        raise BaselineError(f'{where} must be a JSON object')

    comparison_keys = [key for key in COMPARISON_ONLY_KEYS if key in finding]
    if comparison_keys:
        raise BaselineError(
            f'{where} looks like a BaselineComparison entry '
            f'(comparison-only key(s): {", ".join(comparison_keys)}); pass the '
            'original AuditReport JSON, not the --baseline-output comparison'
        )

    category = finding.get('category')
    if category not in AUDIT_CATEGORIES:
        raise BaselineError(
            f'{where}.category must be one of {", ".join(AUDIT_CATEGORIES)} '
            f'(got {category!r})'
        )

    severity = finding.get('severity')
    if severity not in AUDIT_SEVERITIES:
        raise BaselineError(
            f'{where}.severity must be one of {", ".join(AUDIT_SEVERITIES)} '
            f'(got {severity!r})'
        )

    for key in ('title', 'detail'):
        value = finding.get(key)
        if not isinstance(value, str):
            raise BaselineError(
                f'{where}.{key} must be a string (got {value!r})'
            )

    page = finding.get('page')
    if page is not None and (
        isinstance(page, bool) or not isinstance(page, int) or page < 1
    ):
        raise BaselineError(
            f'{where}.page must be null or a positive integer (got {page!r})'
        )

    for key in ('evidence', 'recommendation'):
        value = finding.get(key)
        if value is not None and not isinstance(value, str):
            raise BaselineError(
                f'{where}.{key} must be null or a string (got {value!r})'
            )

    fingerprint = finding.get(FINGERPRINT_KEY)
    if fingerprint is not None and fingerprint != '':
        if not isinstance(fingerprint, str) or not FINGERPRINT_PATTERN.match(
            fingerprint
        ):
            raise BaselineError(
                f'{where}.fingerprint must be 32 lowercase hex characters '
                f'(got {fingerprint!r})'
            )

    return _with_fingerprint(finding, where=where)


def _with_fingerprint(
    finding: Mapping[str, Any],
    *,
    where: Optional[str] = None,
) -> dict[str, Any]:
    """A copy of ``finding`` that always carries a valid fingerprint.

    A missing or empty fingerprint is computed with the engine function; any
    other value must be exactly 32 lowercase hex characters, so an uppercase or
    over-long fingerprint fails instead of being trusted silently.
    """
    item = dict(finding)
    fingerprint = item.get(FINGERPRINT_KEY)
    if fingerprint is None or fingerprint == '':
        item[FINGERPRINT_KEY] = finding_fingerprint(item)
        return item
    if not isinstance(fingerprint, str) or not FINGERPRINT_PATTERN.match(fingerprint):
        label = f'{where}.fingerprint' if where else 'fingerprint'
        raise BaselineError(
            f'{label} must be 32 lowercase hex characters (got {fingerprint!r})'
        )
    return item


# --- comparison -------------------------------------------------------------


def compare_reports(
    current_report: Mapping[str, Any],
    baseline_report: Mapping[str, Any],
    waiver_application: Optional[Any] = None,
) -> dict[str, Any]:
    """Compare two reports and return the deterministic ``BaselineComparison``.

    Findings are matched by fingerprint using a multiset: identical findings on
    the same page pair one-to-one, remaining same-fingerprint pairs become
    ``moved``, and a severity increase on a pair becomes ``escalated``.  The
    ``findings`` list keeps current-report order first (every current finding,
    whatever its status) and then the fixed baseline findings in baseline order.

    ``waiver_application`` is an optional :class:`sidecar.waivers.WaiverApplication`
    (or any object/mapping exposing ``applied``/``expired``/``unused``).  A
    current finding accepted by a waiver becomes ``waived``, which overrides
    ``new``/``existing``/``moved``/``escalated`` and moves it out of those counts;
    the entry then carries a ``waiver`` block with the reason and expiry date.
    ``fixed`` entries are never affected (they are not current findings) and the
    top level gains a ``waivers`` block with the applied/expired/unused counts.
    Passing ``None`` leaves the output exactly as it was before waivers existed.
    """
    current = _prepare_findings(current_report)
    baseline = _prepare_findings(baseline_report)
    applied = _applied_waivers(waiver_application)

    statuses: dict[int, str] = {}
    baseline_pair: dict[int, int] = {}
    matched_baseline: set[int] = set()

    current_by_fingerprint: dict[str, list[int]] = {}
    for index, finding in enumerate(current):
        current_by_fingerprint.setdefault(finding[FINGERPRINT_KEY], []).append(index)

    baseline_by_fingerprint: dict[str, list[int]] = {}
    for index, finding in enumerate(baseline):
        baseline_by_fingerprint.setdefault(finding[FINGERPRINT_KEY], []).append(index)

    for fingerprint, current_indices in current_by_fingerprint.items():
        baseline_indices = baseline_by_fingerprint.get(fingerprint)
        if not baseline_indices:
            for index in current_indices:
                statuses[index] = 'new'
            continue

        # Same fingerprint + same page pairs first (multiset: duplicates kept).
        baseline_by_page: dict[tuple[int, int], list[int]] = {}
        for index in baseline_indices:
            baseline_by_page.setdefault(_page_key(baseline[index]), []).append(index)

        remaining_current: list[int] = []
        for index in current_indices:
            candidates = baseline_by_page.get(_page_key(current[index]))
            if candidates:
                baseline_index = candidates.pop(0)
                statuses[index] = 'existing'
                baseline_pair[index] = baseline_index
                matched_baseline.add(baseline_index)
            else:
                remaining_current.append(index)

        # Remaining same-fingerprint findings pair in page order: moved.
        remaining_baseline = [
            index for index in baseline_indices if index not in matched_baseline
        ]
        remaining_current.sort(key=lambda index: _page_key(current[index]))
        remaining_baseline.sort(key=lambda index: _page_key(baseline[index]))
        for index, baseline_index in zip(remaining_current, remaining_baseline):
            statuses[index] = 'moved'
            baseline_pair[index] = baseline_index
            matched_baseline.add(baseline_index)
        for index in remaining_current[len(remaining_baseline):]:
            statuses[index] = 'new'

    # A severity increase overrides existing/moved.  A decrease keeps the pair.
    for index, baseline_index in baseline_pair.items():
        if _severity_rank(current[index]) > _severity_rank(baseline[baseline_index]):
            statuses[index] = 'escalated'

    # A policy waiver overrides every current status; the baseline pair is kept
    # so the entry can still show where the problem was before.
    for index in applied:
        statuses[index] = 'waived'

    findings: list[dict[str, Any]] = []
    for index, finding in enumerate(current):
        entry: dict[str, Any] = {
            'status': statuses[index],
            'fingerprint': finding[FINGERPRINT_KEY],
            'current': finding,
            'baseline': (
                None
                if baseline_pair.get(index) is None
                else baseline[baseline_pair[index]]
            ),
        }
        waiver = applied.get(index)
        if waiver is not None:
            entry['waiver'] = _waiver_block(waiver)
        findings.append(entry)
    for index, finding in enumerate(baseline):
        if index in matched_baseline:
            continue
        findings.append(
            {
                'status': 'fixed',
                'fingerprint': finding[FINGERPRINT_KEY],
                'current': None,
                'baseline': finding,
            }
        )

    summary = {status: 0 for status in BASELINE_STATUSES}
    for entry in findings:
        summary[entry['status']] += 1

    result: dict[str, Any] = {
        'schemaVersion': BASELINE_SCHEMA_VERSION,
        'tool': _tool_block(current_report),
        'current': {
            'pages': _page_count(current_report),
            'findings': len(current),
        },
        'baseline': {
            'pages': _page_count(baseline_report),
            'findings': len(baseline),
        },
        'summary': summary,
    }
    if waiver_application is not None:
        # ``applied`` always equals ``summary.waived``: one finding matches at
        # most one waiver, so the two views can never disagree.
        result['waivers'] = {
            'applied': summary['waived'],
            'expired': len(_waiver_sequence(waiver_application, 'expired')),
            'unused': len(_waiver_sequence(waiver_application, 'unused')),
        }
    result['findings'] = findings
    return result


# --- helpers ----------------------------------------------------------------


def _findings(report: Any) -> list[Mapping[str, Any]]:
    if not isinstance(report, Mapping):
        return []
    value = report.get('findings')
    if not isinstance(value, (list, tuple)):
        return []
    return [item for item in value if isinstance(item, Mapping)]


def _prepare_findings(report: Any) -> list[dict[str, Any]]:
    """Copy the report's findings and fill in any missing fingerprint."""
    return [_with_fingerprint(finding) for finding in _findings(report)]


def _page_key(finding: Mapping[str, Any]) -> tuple[int, int]:
    """Sort key for page pairing: document-level findings first, then pages."""
    page = finding.get('page')
    if isinstance(page, int) and not isinstance(page, bool):
        return (1, page)
    return (0, 0)


def _severity_rank(finding: Mapping[str, Any]) -> int:
    return SEVERITY_RANK.get(finding.get('severity'), SEVERITY_RANK['info'])


# --- waiver helpers ---------------------------------------------------------


def _applied_waivers(application: Any) -> dict[int, Any]:
    """The ``index -> waiver`` mapping of a waiver application, or ``{}``.

    ``compare_reports`` only needs the applied mapping; the counters are read
    separately so a caller can pass the :class:`~sidecar.waivers.WaiverApplication`
    dataclass or a plain mapping with the same keys.
    """
    if application is None:
        return {}
    applied = (
        application.get('applied')
        if isinstance(application, Mapping)
        else getattr(application, 'applied', None)
    )
    if not isinstance(applied, Mapping):
        return {}
    return {
        index: waiver
        for index, waiver in applied.items()
        if isinstance(index, int) and not isinstance(index, bool)
    }


def _waiver_sequence(application: Any, key: str) -> tuple[Any, ...]:
    """One ``expired``/``unused`` sequence of a waiver application."""
    value = (
        application.get(key)
        if isinstance(application, Mapping)
        else getattr(application, key, None)
    )
    if isinstance(value, (list, tuple)):
        return tuple(value)
    return ()


def _waiver_block(waiver: Any) -> dict[str, str]:
    """The ``waiver`` payload of one comparison entry: reason and expiry date."""
    if isinstance(waiver, Mapping):
        reason, expires = waiver.get('reason'), waiver.get('expires')
    else:
        reason = getattr(waiver, 'reason', None)
        expires = getattr(waiver, 'expires', None)
    if hasattr(expires, 'isoformat'):
        expires = expires.isoformat()
    return {
        'reason': '' if reason is None else str(reason),
        'expires': '' if expires is None else str(expires),
    }



def _page_count(report: Any) -> int:
    if not isinstance(report, Mapping):
        return 0
    document = report.get('document')
    if not isinstance(document, Mapping):
        return 0
    pages = document.get('pages')
    if isinstance(pages, bool) or not isinstance(pages, int):
        return 0
    return max(pages, 0)


def _tool_block(report: Any) -> dict[str, str]:
    """The current report's tool block, with the engine's values as fallback."""
    tool = report.get('tool') if isinstance(report, Mapping) else None
    if isinstance(tool, Mapping):
        name = tool.get('name')
        version = tool.get('version')
        if isinstance(name, str) and name and isinstance(version, str) and version:
            return {'name': name, 'version': version}
    fallback = audit_tool()
    return {'name': fallback['name'], 'version': fallback['version']}


__all__ = [
    'BASELINE_SCHEMA_VERSION',
    'BASELINE_STATUSES',
    'BaselineError',
    'SEVERITY_RANK',
    'compare_reports',
    'load_baseline',
]
