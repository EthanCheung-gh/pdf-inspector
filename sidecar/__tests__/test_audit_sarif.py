"""``sidecar.audit_sarif``: the SARIF 2.1.0 mapping of an audit report.

The renderer is a pure function over an ``AuditReport`` plus an optional
``BaselineComparison``/waiver application, so it is tested without a PDF: the
synthetic reports exercise every mapping row, the rule-id slug and collision
handling, the document-level/page-level location split and determinism.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from audit import finding_fingerprint  # noqa: E402
from audit_sarif import (  # noqa: E402
    SARIF_FINGERPRINT_KEY,
    build_audit_sarif,
    render_audit_sarif,
    slugify_title,
)
from baseline import compare_reports  # noqa: E402
from waivers import Waiver, apply_waivers  # noqa: E402

SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'
INFORMATION_URI = 'https://github.com/EthanCheung-gh/pdf-inspector'
WAIVER_REASON = 'Legacy template; tracked in DOC-1234'
WAIVER_EXPIRES = date(2999, 12, 31)


# --- fixtures ---------------------------------------------------------------


def _finding(
    *,
    category: str = 'fonts',
    severity: str = 'warning',
    page=None,
    title: str = 'Font not embedded',
    detail: str = 'Font F1 is not embedded.',
    evidence=None,
    recommendation=None,
    fingerprint: bool = True,
) -> dict:
    finding = {
        'category': category,
        'severity': severity,
        'page': page,
        'title': title,
        'detail': detail,
        'evidence': evidence,
        'recommendation': recommendation,
    }
    if fingerprint:
        finding['fingerprint'] = finding_fingerprint(finding)
    return finding


def _report(findings) -> dict:
    findings = list(findings)
    counts = {'total': len(findings), 'errors': 0, 'warnings': 0, 'info': 0}
    for finding in findings:
        if finding['severity'] == 'error':
            counts['errors'] += 1
        elif finding['severity'] == 'warning':
            counts['warnings'] += 1
        else:
            counts['info'] += 1
    return {
        'schemaVersion': 1,
        'tool': {'name': 'pdf-inspector', 'version': '0.3.3'},
        'document': {'pages': 1},
        'summary': counts,
        'findings': findings,
    }


def _comparison(current, baseline, waivers=None) -> dict:
    return compare_reports(_report(current), _report(baseline), waivers)


def _waiver_application(findings, reason: str = WAIVER_REASON):
    waivers = [
        Waiver(
            fingerprint=finding['fingerprint'],
            page=None,
            reason=reason,
            expires=WAIVER_EXPIRES,
        )
        for finding in findings
    ]
    return apply_waivers(findings, waivers)


def _results(document) -> list:
    return document['runs'][0]['results']


def _rules(document) -> list:
    return document['runs'][0]['tool']['driver']['rules']


# --- document shape ---------------------------------------------------------


def test_top_level_shape_and_driver():
    data = build_audit_sarif(_report([_finding()]), 'docs/report.pdf')

    assert list(data) == ['$schema', 'version', 'runs']
    assert data['$schema'] == SCHEMA
    assert data['version'] == '2.1.0'
    assert len(data['runs']) == 1

    run = data['runs'][0]
    assert run['columnKind'] == 'utf16CodeUnits'
    driver = run['tool']['driver']
    assert list(driver) == ['name', 'version', 'informationUri', 'rules']
    assert driver['name'] == 'pdf-inspector'
    assert driver['version'] == '0.3.3'
    assert driver['informationUri'] == INFORMATION_URI


def test_driver_version_falls_back_to_the_engine_version():
    report = _report([_finding()])
    report['tool'] = {}

    driver = build_audit_sarif(report, 'a.pdf')['runs'][0]['tool']['driver']

    assert re.fullmatch(r'\d+\.\d+\.\d+', driver['version'])


def test_render_is_json_with_a_trailing_newline():
    text = render_audit_sarif(_report([_finding()]), 'a.pdf')

    assert text.endswith('\n')
    assert not text.endswith('\n\n')
    assert json.loads(text) == build_audit_sarif(_report([_finding()]), 'a.pdf')


def test_empty_report_has_no_results_and_no_rules():
    data = build_audit_sarif(_report([]), 'a.pdf')

    assert _results(data) == []
    assert _rules(data) == []


# --- result mapping ---------------------------------------------------------


@pytest.mark.parametrize(
    'severity, level',
    [('error', 'error'), ('warning', 'warning'), ('info', 'note')],
)
def test_severity_maps_onto_the_sarif_level(severity, level):
    result = _results(build_audit_sarif(_report([_finding(severity=severity)]), 'a.pdf'))[0]

    assert result['level'] == level


def test_message_is_title_and_detail():
    finding = _finding(title='Font not embedded', detail='Font F1 is not embedded.')
    result = _results(build_audit_sarif(_report([finding]), 'a.pdf'))[0]

    assert result['message'] == {'text': 'Font not embedded: Font F1 is not embedded.'}


def test_message_is_the_title_when_the_detail_is_empty():
    finding = _finding(title='Font not embedded', detail='   ')
    result = _results(build_audit_sarif(_report([finding]), 'a.pdf'))[0]

    assert result['message'] == {'text': 'Font not embedded'}


def test_rule_id_title_and_tags():
    finding = _finding(
        category='images',
        severity='warning',
        title='Page 3 has a low-resolution image',
        recommendation='Use a higher-resolution image.',
    )
    data = build_audit_sarif(_report([finding]), 'a.pdf')

    rule = _rules(data)[0]
    assert rule == {
        'id': 'pdf-inspector/images/page-3-has-a-low-resolution-image',
        'shortDescription': {'text': 'Page 3 has a low-resolution image'},
        'help': {'text': 'Use a higher-resolution image.'},
        'properties': {'tags': ['images', 'warning']},
    }
    result = _results(data)[0]
    assert result['ruleId'] == rule['id']
    assert result['ruleIndex'] == 0


def test_rule_help_is_omitted_without_a_recommendation():
    data = build_audit_sarif(_report([_finding(recommendation=None)]), 'a.pdf')

    assert 'help' not in _rules(data)[0]


def test_results_keep_report_order():
    findings = [
        _finding(category='fonts', title='B font', page=2),
        _finding(category='metadata', title='A metadata', page=None, severity='info'),
        _finding(category='pages', title='C page', page=1, severity='error'),
    ]
    data = build_audit_sarif(_report(findings), 'a.pdf')

    assert [result['ruleId'] for result in _results(data)] == [
        'pdf-inspector/fonts/b-font',
        'pdf-inspector/metadata/a-metadata',
        'pdf-inspector/pages/c-page',
    ]


# --- locations --------------------------------------------------------------


def test_page_finding_carries_uri_and_start_page():
    data = build_audit_sarif(_report([_finding(page=3)]), 'docs/report.pdf')

    location = _results(data)[0]['locations'][0]
    assert location == {
        'physicalLocation': {
            'artifactLocation': {'uri': 'docs/report.pdf'},
            'region': {'startPage': 3},
        }
    }


def test_document_level_finding_has_no_location():
    data = build_audit_sarif(_report([_finding(page=None)]), 'docs/report.pdf')

    assert 'locations' not in _results(data)[0]


def test_backslashes_are_normalised_and_sarif_uri_wins():
    windows = build_audit_sarif(_report([_finding(page=1)]), 'docs\\sub\\report.pdf')
    assert _results(windows)[0]['locations'][0]['physicalLocation']['artifactLocation'] == {
        'uri': 'docs/sub/report.pdf'
    }

    overridden = build_audit_sarif(
        _report([_finding(page=1)]), 'docs/sub/report.pdf', uri='ci\\input.pdf'
    )
    assert _results(overridden)[0]['locations'][0]['physicalLocation'][
        'artifactLocation'
    ] == {'uri': 'ci/input.pdf'}


# --- rules: dedupe, sorting and collisions ----------------------------------


def test_rules_are_deduped_and_sorted_and_rule_index_points_at_them():
    findings = [
        _finding(category='pages', title='Same page title', page=1),
        _finding(category='fonts', title='Same page title', page=2),
        _finding(category='fonts', title='Another font title', page=2),
    ]
    data = build_audit_sarif(_report(findings), 'a.pdf')

    rules = _rules(data)
    ids = [rule['id'] for rule in rules]
    assert ids == sorted(ids)
    assert len(ids) == len(set(ids))
    assert len(rules) == 3

    for result in _results(data):
        assert rules[result['ruleIndex']]['id'] == result['ruleId']


def test_repeated_title_and_category_share_one_rule():
    findings = [
        _finding(title='Repeat me', page=1),
        _finding(title='Repeat me', page=2),
    ]
    data = build_audit_sarif(_report(findings), 'a.pdf')

    assert len(_rules(data)) == 1
    assert [result['ruleIndex'] for result in _results(data)] == [0, 0]


@pytest.mark.parametrize(
    'first, second, base',
    [
        ('A/B', 'A-B', 'pdf-inspector/fonts/a-b'),
        # Two non-ASCII titles collapse onto the fallback slug.
        ('ÄÖÜ', 'ÀÉÎ', 'pdf-inspector/fonts/finding'),
    ],
)
def test_colliding_slugs_get_a_stable_title_hash(first, second, base):
    findings = [
        _finding(title=first, page=1),
        _finding(title=second, page=2),
    ]
    data = build_audit_sarif(_report(findings), 'a.pdf')

    results = _results(data)
    suffix = hashlib.sha256(first.encode('utf-8')).hexdigest()[:8]
    assert results[0]['ruleId'] == f'{base}-{suffix}'
    assert results[1]['ruleId'] == (
        f'{base}-{hashlib.sha256(second.encode("utf-8")).hexdigest()[:8]}'
    )
    assert results[0]['ruleId'] != results[1]['ruleId']
    assert len(_rules(data)) == 2
    # Deterministic: the same input produces the same ids again.
    assert _results(build_audit_sarif(_report(findings), 'a.pdf')) == results


def test_a_non_colliding_title_keeps_the_plain_slug():
    findings = [_finding(title='A/B', page=1)]
    data = build_audit_sarif(_report(findings), 'a.pdf')

    assert _results(data)[0]['ruleId'] == 'pdf-inspector/fonts/a-b'


@pytest.mark.parametrize(
    'title, slug',
    [
        ('Page 3 has a low-resolution image', 'page-3-has-a-low-resolution-image'),
        ('  --Weird__Name!!  ', 'weird-name'),
        ('UPPER Case', 'upper-case'),
        ('ÄÖÜ', 'finding'),
        ('', 'finding'),
        ('...', 'finding'),
    ],
)
def test_slugify_title(title, slug):
    assert slugify_title(title) == slug


def test_slug_is_capped_at_64_characters():
    title = 'word ' * 40
    slug = slugify_title(title)

    assert len(slug) <= 64
    assert not slug.startswith('-') and not slug.endswith('-')
    data = build_audit_sarif(_report([_finding(title=title)]), 'a.pdf')
    rule_id = _results(data)[0]['ruleId']
    assert rule_id == f'pdf-inspector/fonts/{slug}'


# --- fingerprints -----------------------------------------------------------


def test_partial_fingerprints_use_the_documented_key():
    finding = _finding(page=1)
    result = _results(build_audit_sarif(_report([finding]), 'a.pdf'))[0]

    assert SARIF_FINGERPRINT_KEY == 'pdfInspectorFinding/v1'
    assert result['partialFingerprints'] == {
        'pdfInspectorFinding/v1': finding['fingerprint']
    }


def test_a_finding_without_a_fingerprint_gets_the_engine_one():
    finding = _finding(page=1, fingerprint=False)
    result = _results(build_audit_sarif(_report([finding]), 'a.pdf'))[0]

    assert result['partialFingerprints'] == {
        'pdfInspectorFinding/v1': finding_fingerprint(finding)
    }


def test_fingerprints_are_stable_across_page_and_severity_changes():
    first = _finding(page=1, severity='info')
    second = _finding(page=7, severity='error')

    assert _results(build_audit_sarif(_report([first]), 'a.pdf'))[0][
        'partialFingerprints'
    ] == _results(build_audit_sarif(_report([second]), 'a.pdf'))[0][
        'partialFingerprints'
    ]


# --- baselineState ----------------------------------------------------------


def test_baseline_state_maps_every_comparison_status():
    unchanged = _finding(title='Existing finding', page=1)
    moved_before = _finding(title='Moved finding', page=1)
    moved_after = _finding(title='Moved finding', page=4)
    escalated = _finding(title='Escalated finding', page=2, severity='warning')
    escalated_before = _finding(title='Escalated finding', page=2, severity='info')
    fresh = _finding(title='Brand new finding', page=5)

    baseline = [unchanged, moved_before, escalated_before]
    current = [
        _finding(title='Existing finding', page=1),
        moved_after,
        escalated,
        fresh,
    ]
    comparison = _comparison(current, baseline)
    data = build_audit_sarif(_report(current), 'a.pdf', comparison)

    states = [result.get('baselineState') for result in _results(data)]
    assert states == ['unchanged', 'unchanged', 'new', 'new']
    assert comparison['summary']['moved'] == 1
    assert comparison['summary']['escalated'] == 1
    assert comparison['summary']['new'] == 1


def test_without_a_comparison_there_is_no_baseline_state():
    data = build_audit_sarif(_report([_finding(page=1)]), 'a.pdf')

    assert 'baselineState' not in _results(data)[0]


def test_fixed_findings_do_not_become_results():
    current = [_finding(title='Still here', page=1)]
    baseline = [
        _finding(title='Still here', page=1),
        _finding(title='Already fixed', page=2),
    ]
    comparison = _comparison(current, baseline)
    data = build_audit_sarif(_report(current), 'a.pdf', comparison)

    assert comparison['summary']['fixed'] == 1
    assert len(_results(data)) == 1
    assert _results(data)[0]['message']['text'].startswith('Still here')


# --- waivers ----------------------------------------------------------------


def test_waived_findings_get_suppressions_instead_of_a_baseline_state():
    finding = _finding(title='Waived warning', page=1)
    current = [finding, _finding(title='Not waived', page=2)]
    baseline = [_finding(title='Not waived', page=2)]
    application = apply_waivers(current, _waiver_application([finding]).applied.values())
    comparison = _comparison(current, baseline, application)

    data = build_audit_sarif(_report(current), 'a.pdf', comparison, application)

    waived, kept = _results(data)
    assert waived['suppressions'] == [
        {'kind': 'external', 'status': 'accepted', 'justification': WAIVER_REASON}
    ]
    assert 'baselineState' not in waived
    assert 'suppressions' not in kept
    # The non-waived finding keeps its ordinary comparison state.
    assert kept['baselineState'] == 'unchanged'


def test_a_waiver_application_alone_suppresses_without_a_baseline():
    finding = _finding(title='Waived warning', page=1)
    application = _waiver_application([finding])

    data = build_audit_sarif(_report([finding]), 'a.pdf', None, application)

    result = _results(data)[0]
    assert result['suppressions'][0]['justification'] == WAIVER_REASON
    assert 'baselineState' not in result


def test_the_comparison_reason_is_used_when_no_application_is_passed():
    finding = _finding(title='Waived warning', page=1)
    application = _waiver_application([finding])
    comparison = _comparison([finding], [], application)

    data = build_audit_sarif(_report([finding]), 'a.pdf', comparison)

    assert _results(data)[0]['suppressions'] == [
        {'kind': 'external', 'status': 'accepted', 'justification': WAIVER_REASON}
    ]


def test_a_waiver_without_a_reason_omits_the_justification():
    finding = _finding(title='Waived warning', page=1)
    application = _waiver_application([finding], reason='   ')

    data = build_audit_sarif(_report([finding]), 'a.pdf', None, application)

    assert _results(data)[0]['suppressions'] == [
        {'kind': 'external', 'status': 'accepted'}
    ]


def test_the_waiver_path_never_reaches_the_payload():
    finding = _finding(title='Waived warning', page=1)
    comparison = _comparison([finding], [], _waiver_application([finding]))

    text = render_audit_sarif(_report([finding]), 'a.pdf', comparison)

    # Only the policy facts (reason, status) are rendered, never the file.
    assert 'waivers.json' not in text
    assert 'expires' not in text
    assert WAIVER_REASON in text


# --- determinism ------------------------------------------------------------


def test_two_renders_are_byte_identical():
    findings = [
        _finding(category='fonts', title='Font not embedded', page=1),
        _finding(category='metadata', title='Missing document language', page=None, severity='info'),
    ]
    first = render_audit_sarif(_report(findings), 'docs/report.pdf')
    second = render_audit_sarif(_report(findings), 'docs/report.pdf')

    assert first == second
    assert first.encode('utf-8') == second.encode('utf-8')


def test_the_payload_has_no_timestamp_or_absolute_path():
    text = render_audit_sarif(_report([_finding(page=1)]), 'docs/report.pdf')

    assert not re.search(r'\d{4}-\d{2}-\d{2}', text)
    assert not re.search(r'\d{2}:\d{2}:\d{2}', text)
    assert str(Path.home()) not in text
    assert 'hostname' not in text.lower()
