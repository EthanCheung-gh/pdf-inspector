"""SARIF 2.1.0 rendering for :class:`~sidecar.audit.AuditReport` dictionaries.

This is a pure formatter: it reads one report (plus an optional
``BaselineComparison`` from :mod:`sidecar.baseline` and an optional
:class:`sidecar.waivers.WaiverApplication`), never opens a PDF, never writes a
file and never touches the network.  The same ``AuditReport`` that produces the
summary, JSON and HTML payloads is mapped onto SARIF so a code-scanning consumer
sees exactly the findings the CLI reports.

Mapping (see ``docs/ci.md``):

======  =====================================================================
SARIF   source
======  =====================================================================
``runs[0].tool.driver.name``         ``pdf-inspector``
``runs[0].tool.driver.version``      ``report.tool.version``
``runs[0].tool.driver.rules[]``      one rule per unique ``ruleId``, sorted
``ruleId``                           ``pdf-inspector/<category>/<slug(title)>``
``results[].level``                  ``error``/``warning``/``info`` -> ``error``/``warning``/``note``
``results[].message.text``           ``title: detail`` (``title`` when no detail)
``results[].locations[]``            omitted for document-level findings
``...region.startPage``              ``finding.page``
``...artifactLocation.uri``          ``--sarif-uri`` or the input argument, ``\\`` -> ``/``
``results[].partialFingerprints``    ``{"pdfInspectorFinding/v1": fingerprint}``
``results[].baselineState``          ``new``/``escalated`` -> ``new``, ``existing``/``moved`` -> ``unchanged``
``results[].suppressions[]``         waived findings: ``external``/``accepted`` + reason
======  =====================================================================

Determinism is part of the contract: rules are sorted by ``ruleId``, results
keep report order, no timestamp, hostname or absolute path is ever manufactured
by this module, and rendering the same report twice produces byte-identical
text.  Two different titles that collapse onto the same slug get a stable
``-<sha256(title)[:8]>`` suffix, so a rule id never silently merges two checks.

A finding without a ``fingerprint`` (a hand-written or pre-fingerprint report)
gets one computed by :func:`sidecar.audit.finding_fingerprint`, exactly like
:mod:`sidecar.baseline` and :mod:`sidecar.waivers` do, so every result always
carries ``partialFingerprints``.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

try:  # imported as ``sidecar.audit_sarif`` (namespace package)
    from .audit import FINGERPRINT_KEY, finding_fingerprint, tool as audit_tool
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from audit import FINGERPRINT_KEY, finding_fingerprint, tool as audit_tool


SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'
SARIF_VERSION = '2.1.0'
SARIF_COLUMN_KIND = 'utf16CodeUnits'
SARIF_TOOL_NAME = 'pdf-inspector'
SARIF_INFORMATION_URI = 'https://github.com/EthanCheung-gh/pdf-inspector'

# The partial fingerprint name is part of the consumer contract: changing it
# makes every previously uploaded alert look new.
SARIF_FINGERPRINT_KEY = 'pdfInspectorFinding/v1'

# ``<category>/<slug>`` rule id prefix; the driver name is not repeated.
RULE_ID_PREFIX = 'pdf-inspector'

# Slug limits documented in the plan: lowercase ASCII, dash runs, 64 chars.
SLUG_MAX_LENGTH = 64
SLUG_FALLBACK = 'finding'
CATEGORY_FALLBACK = 'unknown'

# Audit severities map onto SARIF levels; anything unknown is a note (never an
# error), so a malformed report cannot raise the severity of a run.
LEVELS = {'error': 'error', 'warning': 'warning', 'info': 'note'}
DEFAULT_LEVEL = 'note'

# ``BaselineComparison`` status -> ``baselineState``.  ``waived`` and ``fixed``
# are intentionally absent: a waived result carries a suppression instead and a
# fixed finding has no current result to attach a state to.
BASELINE_STATES = {
    'new': 'new',
    'escalated': 'new',
    'existing': 'unchanged',
    'moved': 'unchanged',
}

_SLUG_RUNS = re.compile(r'-+')


# --- small helpers ----------------------------------------------------------


def _text(value: Any) -> str:
    return '' if value is None else str(value)


def _normalize_path(value: Any) -> str:
    """The SARIF ``uri`` of the audited file: backslashes become forward slashes."""
    return _text(value).replace('\\', '/')


def _slug(value: Any) -> str:
    """Lowercase ASCII letters/digits, every other run becomes one ``-``.

    Trimmed, capped at :data:`SLUG_MAX_LENGTH` characters and possibly empty, so
    the caller decides on its own fallback token.
    """
    chars = [
        char if ('a' <= char <= 'z' or '0' <= char <= '9') else '-'
        for char in _text(value).lower()
    ]
    slug = _SLUG_RUNS.sub('-', ''.join(chars)).strip('-')
    return slug[:SLUG_MAX_LENGTH].strip('-')


def slugify_title(value: Any) -> str:
    """A rule-id slug: lowercase ASCII letters/digits, other runs become ``-``.

    Every non-ASCII character is a separator, so two different non-ASCII titles
    can collide; the collision handling in :func:`_rule_ids` disambiguates them
    with a title hash instead of merging two checks.  The result is trimmed,
    capped at :data:`SLUG_MAX_LENGTH` characters and falls back to ``finding``
    when nothing printable is left.
    """
    return _slug(value) or SLUG_FALLBACK


def _category_part(finding: Mapping[str, Any]) -> str:
    return _slug(finding.get('category')) or CATEGORY_FALLBACK


def _title_part(finding: Mapping[str, Any]) -> str:
    return _slug(finding.get('title')) or SLUG_FALLBACK


def _title_text(finding: Mapping[str, Any]) -> str:
    return _text(finding.get('title'))


def _fingerprint(finding: Mapping[str, Any]) -> str:
    """The finding's own fingerprint, or the engine one when it is missing."""
    value = finding.get(FINGERPRINT_KEY)
    if isinstance(value, str) and value:
        return value
    return finding_fingerprint(finding)


def _page(finding: Mapping[str, Any]) -> Optional[int]:
    page = finding.get('page')
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        return None
    return page


def _message_text(finding: Mapping[str, Any]) -> str:
    title = _title_text(finding) or '(untitled finding)'
    detail = _text(finding.get('detail')).strip()
    return f'{title}: {detail}' if detail else title


def _findings(report: Any) -> List[Mapping[str, Any]]:
    if not isinstance(report, Mapping):
        return []
    value = report.get('findings')
    if not isinstance(value, (list, tuple)):
        return []
    return [item for item in value if isinstance(item, Mapping)]


# --- rules ------------------------------------------------------------------


def _rule_ids(findings: Sequence[Mapping[str, Any]]) -> List[str]:
    """The rule id of every finding, in report order.

    ``pdf-inspector/<category>/<slug(title)>``; when two *different* titles
    collapse onto the same slug (``A/B`` and ``A-B``, or two non-ASCII titles)
    both ids gain ``-<sha256(title)[:8]>`` so neither check hides the other.
    """
    bases = [
        f'{RULE_ID_PREFIX}/{_category_part(finding)}/{_title_part(finding)}'
        for finding in findings
    ]
    titles_by_base: Dict[str, set] = {}
    for base, finding in zip(bases, findings):
        titles_by_base.setdefault(base, set()).add(_title_text(finding))

    ids: List[str] = []
    for base, finding in zip(bases, findings):
        if len(titles_by_base[base]) > 1:
            digest = hashlib.sha256(
                _title_text(finding).encode('utf-8')
            ).hexdigest()[:8]
            ids.append(f'{base}-{digest}')
        else:
            ids.append(base)
    return ids


def _rule(finding: Mapping[str, Any], rule_id: str) -> Dict[str, Any]:
    """One ``reportingDescriptor``: title, recommendation and search tags."""
    rule: Dict[str, Any] = {
        'id': rule_id,
        'shortDescription': {'text': _title_text(finding) or '(untitled finding)'},
    }
    recommendation = _text(finding.get('recommendation')).strip()
    if recommendation:
        rule['help'] = {'text': recommendation}
    rule['properties'] = {
        'tags': [_category_part(finding), _text(finding.get('severity')) or 'unknown'],
    }
    return rule


def _rules(
    findings: Sequence[Mapping[str, Any]], rule_ids: Sequence[str]
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """The sorted, de-duplicated rule list and its ``ruleId -> ruleIndex`` map.

    Rules are sorted by ``ruleId`` so the array does not depend on report order;
    the first finding that produced a rule supplies its description and tags.
    """
    unique: Dict[str, Dict[str, Any]] = {}
    for finding, rule_id in zip(findings, rule_ids):
        if rule_id not in unique:
            unique[rule_id] = _rule(finding, rule_id)
    ordered = [unique[rule_id] for rule_id in sorted(unique)]
    return ordered, {rule['id']: index for index, rule in enumerate(ordered)}


# --- baseline and waiver views ----------------------------------------------


def _current_entries(
    comparison: Any, findings: Sequence[Mapping[str, Any]]
) -> List[Tuple[int, Mapping[str, Any]]]:
    """``(index, entry)`` pairs of a comparison's current findings.

    A ``BaselineComparison`` lists every current finding first, in report order,
    so a matching length pairs positionally.  A hand-written comparison with a
    different length is matched by fingerprint instead of mislabelling results.
    """
    if not isinstance(comparison, Mapping):
        return []
    entries = [
        entry
        for entry in comparison.get('findings') or ()
        if isinstance(entry, Mapping) and isinstance(entry.get('current'), Mapping)
    ]
    if not entries:
        return []
    if len(entries) == len(findings):
        return list(enumerate(entries))

    by_fingerprint: Dict[str, Mapping[str, Any]] = {}
    for entry in entries:
        by_fingerprint.setdefault(_fingerprint(entry['current']), entry)
    pairs: List[Tuple[int, Mapping[str, Any]]] = []
    for index, finding in enumerate(findings):
        entry = by_fingerprint.get(_fingerprint(finding))
        if entry is not None:
            pairs.append((index, entry))
    return pairs


def _baseline_states(
    comparison: Any, findings: Sequence[Mapping[str, Any]]
) -> Dict[int, str]:
    """``index -> baselineState`` for the current findings of a comparison."""
    states: Dict[int, str] = {}
    for index, entry in _current_entries(comparison, findings):
        state = BASELINE_STATES.get(_text(entry.get('status')))
        if state is not None:
            states[index] = state
    return states


def _waiver_reason(value: Any) -> str:
    """The trimmed ``reason`` of a waiver block, a waiver or a plain mapping."""
    if isinstance(value, Mapping):
        reason = value.get('reason')
    else:
        reason = getattr(value, 'reason', None)
    return _text(reason).strip()


def _applied_waivers(application: Any) -> Mapping[int, Any]:
    """The ``index -> waiver`` mapping of a waiver application, or ``{}``."""
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


def _waived_reasons(
    comparison: Any,
    waivers: Any,
    findings: Sequence[Mapping[str, Any]],
) -> Dict[int, str]:
    """``index -> justification`` for the current findings a waiver accepted.

    The comparison artifact already carries the waiver it matched, so its reason
    wins; a waiver application used without a comparison (or a report where the
    reason was not recorded) fills in the rest.  The reason is only ever the
    policy text - the waiver file path never reaches the payload.
    """
    reasons: Dict[int, str] = {}
    for index, entry in _current_entries(comparison, findings):
        if _text(entry.get('status')) != 'waived':
            continue
        reasons[index] = _waiver_reason(entry.get('waiver'))
    for index, waiver in _applied_waivers(waivers).items():
        if index in reasons:
            continue
        reasons[index] = _waiver_reason(waiver)
    return reasons


# --- results ----------------------------------------------------------------


def _location(finding: Mapping[str, Any], uri: str) -> Optional[Dict[str, Any]]:
    """The physical location of a page-level finding, ``None`` when document-level."""
    page = _page(finding)
    if page is None:
        return None
    physical: Dict[str, Any] = {}
    if uri:
        physical['artifactLocation'] = {'uri': uri}
    physical['region'] = {'startPage': page}
    return {'physicalLocation': physical}


def _suppressions(reason: str) -> List[Dict[str, Any]]:
    """``suppressions[]`` for a waived finding (``external`` / ``accepted``)."""
    suppression: Dict[str, Any] = {'kind': 'external', 'status': 'accepted'}
    if reason:
        suppression['justification'] = reason
    return [suppression]


def _result(
    finding: Mapping[str, Any],
    rule_id: str,
    rule_index: int,
    *,
    uri: str,
    baseline_state: Optional[str] = None,
    suppression_reason: Optional[str] = None,
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        'ruleId': rule_id,
        'ruleIndex': rule_index,
        'level': LEVELS.get(_text(finding.get('severity')), DEFAULT_LEVEL),
        'message': {'text': _message_text(finding)},
    }
    location = _location(finding, uri)
    if location is not None:
        result['locations'] = [location]
    result['partialFingerprints'] = {SARIF_FINGERPRINT_KEY: _fingerprint(finding)}
    if baseline_state is not None:
        result['baselineState'] = baseline_state
    if suppression_reason is not None:
        result['suppressions'] = _suppressions(suppression_reason)
    return result


# --- rendering --------------------------------------------------------------


def _driver(report: Mapping[str, Any]) -> Dict[str, Any]:
    tool_block = report.get('tool')
    version = ''
    if isinstance(tool_block, Mapping):
        version = _text(tool_block.get('version')).strip()
    if not version:
        version = _text(audit_tool().get('version')) or '0.0.0'
    return {
        'name': SARIF_TOOL_NAME,
        'version': version,
        'informationUri': SARIF_INFORMATION_URI,
    }


def build_audit_sarif(
    report: Mapping[str, Any],
    source_label: Any = None,
    comparison: Optional[Mapping[str, Any]] = None,
    waivers: Optional[Any] = None,
    *,
    uri: Optional[str] = None,
) -> Dict[str, Any]:
    """The SARIF 2.1.0 document of one audit report, as a plain dict.

    ``source_label`` is the input argument as the caller received it (relative
    stays relative); ``uri`` overrides it for a consumer that needs a different
    artifact path.  ``comparison`` adds ``baselineState`` and the comparison's
    waiver reasons, ``waivers`` adds suppressions for a run without a baseline.
    """
    findings = _findings(report)
    rule_ids = _rule_ids(findings)
    rules, rule_index = _rules(findings, rule_ids)

    artifact_uri = _normalize_path(uri if uri else source_label)
    states = _baseline_states(comparison, findings)
    waived = _waived_reasons(comparison, waivers, findings)

    results: List[Dict[str, Any]] = []
    for index, finding in enumerate(findings):
        suppression_reason = waived.get(index)
        results.append(
            _result(
                finding,
                rule_ids[index],
                rule_index[rule_ids[index]],
                uri=artifact_uri,
                # A waived result is dismissed by its suppression, not relabelled
                # as new/unchanged history.
                baseline_state=None if suppression_reason is not None else states.get(index),
                suppression_reason=suppression_reason,
            )
        )

    driver = _driver(report)
    driver['rules'] = rules

    return {
        '$schema': SARIF_SCHEMA,
        'version': SARIF_VERSION,
        'runs': [
            {
                'tool': {'driver': driver},
                'columnKind': SARIF_COLUMN_KIND,
                'results': results,
            }
        ],
    }


def render_audit_sarif(
    report: Mapping[str, Any],
    source_label: Any = None,
    comparison: Optional[Mapping[str, Any]] = None,
    waivers: Optional[Any] = None,
    *,
    uri: Optional[str] = None,
) -> str:
    """Render one audit report as a deterministic SARIF 2.1.0 JSON document.

    The payload ends with a single newline and uses two-space indentation like
    the JSON/HTML payloads, so ``--output`` files and stdout stay comparable.
    """
    payload = build_audit_sarif(
        report, source_label, comparison, waivers, uri=uri
    )
    return json.dumps(payload, indent=2, ensure_ascii=False) + '\n'


__all__ = [
    'BASELINE_STATES',
    'DEFAULT_LEVEL',
    'LEVELS',
    'RULE_ID_PREFIX',
    'SARIF_COLUMN_KIND',
    'SARIF_FINGERPRINT_KEY',
    'SARIF_INFORMATION_URI',
    'SARIF_SCHEMA',
    'SARIF_TOOL_NAME',
    'SARIF_VERSION',
    'SLUG_FALLBACK',
    'SLUG_MAX_LENGTH',
    'build_audit_sarif',
    'render_audit_sarif',
    'slugify_title',
]
