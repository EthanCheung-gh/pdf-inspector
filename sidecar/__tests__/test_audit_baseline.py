"""Baseline loading and report comparison: statuses, counts and the contract."""

from __future__ import annotations

import copy
import json
import re
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from audit import finding_fingerprint, summarize_findings  # noqa: E402
from baseline import (  # noqa: E402
    BASELINE_STATUSES,
    BaselineError,
    compare_reports,
    load_baseline,
)
from waivers import Waiver, apply_waivers  # noqa: E402

HEX32 = re.compile(r"[0-9a-f]{32}")
EMPTY_COUNTS = {
    "new": 0,
    "existing": 0,
    "moved": 0,
    "escalated": 0,
    "fixed": 0,
    "waived": 0,
}


# --- fixture builders -------------------------------------------------------


def _finding(
    *,
    category: str = "fonts",
    severity: str = "warning",
    page=None,
    title: str = "Title",
    detail: str = "Detail",
    evidence=None,
    recommendation=None,
    fingerprint=None,
) -> dict:
    finding = {
        "category": category,
        "severity": severity,
        "page": page,
        "title": title,
        "detail": detail,
        "evidence": evidence,
        "recommendation": recommendation,
    }
    if fingerprint is not None:
        finding["fingerprint"] = fingerprint
    return finding


def _report(findings, *, pages: int = 1, version: str = "0.3.3") -> dict:
    findings = list(findings)
    return {
        "schemaVersion": 1,
        "tool": {"name": "pdf-inspector", "version": version},
        "document": {
            "pages": pages,
            "version": "1.4",
            "encrypted": False,
            "title": None,
            "author": None,
            "producer": None,
            "language": None,
            "tagged": False,
        },
        "summary": summarize_findings(findings),
        "findings": findings,
    }


def _statuses(result) -> list[str]:
    return [entry["status"] for entry in result["findings"]]


def _write(path: Path, data) -> str:
    path.write_text(json.dumps(data), encoding="utf-8")
    return str(path)


# --- status rules -----------------------------------------------------------


def test_empty_baseline_marks_every_current_finding_new():
    current = _report([_finding(title="A"), _finding(title="B", page=2)])

    result = compare_reports(current, _report([]))

    assert _statuses(result) == ["new", "new"]
    assert result["summary"] == {**EMPTY_COUNTS, "new": 2}
    assert result["current"] == {"pages": 1, "findings": 2}
    assert result["baseline"] == {"pages": 1, "findings": 0}
    assert all(entry["baseline"] is None for entry in result["findings"])


def test_empty_current_marks_every_baseline_finding_fixed():
    baseline = _report([_finding(title="A"), _finding(title="B", page=2)])

    result = compare_reports(_report([]), baseline)

    assert _statuses(result) == ["fixed", "fixed"]
    assert result["summary"] == {**EMPTY_COUNTS, "fixed": 2}
    assert all(entry["current"] is None for entry in result["findings"])
    assert [entry["baseline"]["title"] for entry in result["findings"]] == ["A", "B"]


def test_both_reports_empty_yields_zero_counts():
    result = compare_reports(_report([]), _report([]))

    assert result["findings"] == []
    assert result["summary"] == EMPTY_COUNTS
    assert result["current"] == {"pages": 1, "findings": 0}
    assert result["baseline"] == {"pages": 1, "findings": 0}


def test_identical_reports_are_all_existing():
    findings = [
        _finding(title="A", page=1),
        _finding(title="B", page=2, severity="info"),
    ]

    result = compare_reports(
        _report(findings, pages=4),
        _report(copy.deepcopy(findings), pages=2),
    )

    assert _statuses(result) == ["existing", "existing"]
    assert result["summary"] == {**EMPTY_COUNTS, "existing": 2}
    assert result["current"] == {"pages": 4, "findings": 2}
    assert result["baseline"] == {"pages": 2, "findings": 2}
    for entry in result["findings"]:
        assert entry["current"] == entry["baseline"]


def test_same_page_duplicates_pair_without_losing_items():
    duplicate = _finding(title="Duplicate", page=2)

    result = compare_reports(
        _report([duplicate, copy.deepcopy(duplicate)]),
        _report([copy.deepcopy(duplicate), copy.deepcopy(duplicate)]),
    )
    assert _statuses(result) == ["existing", "existing"]

    result = compare_reports(
        _report([duplicate, copy.deepcopy(duplicate)]),
        _report([copy.deepcopy(duplicate)]),
    )
    assert _statuses(result) == ["existing", "new"]

    result = compare_reports(
        _report([duplicate]),
        _report([copy.deepcopy(duplicate), copy.deepcopy(duplicate)]),
    )
    assert _statuses(result) == ["existing", "fixed"]
    assert result["summary"]["existing"] == 1
    assert result["summary"]["fixed"] == 1


def test_finding_moved_to_another_page_is_moved():
    result = compare_reports(
        _report([_finding(page=5)]),
        _report([_finding(page=3)]),
    )

    entry = result["findings"][0]
    assert entry["status"] == "moved"
    assert entry["current"]["page"] == 5
    assert entry["baseline"]["page"] == 3
    assert result["summary"] == {**EMPTY_COUNTS, "moved": 1}


def test_page_scoped_finding_shifted_to_another_page_is_moved():
    """The engine embeds the page number in title/detail; identity must survive."""
    current = _report(
        [
            _finding(
                category="images",
                page=4,
                title="Page 4 has a low-resolution image",
                detail="Image 0 on page 4 is drawn at 72 dpi.",
            )
        ]
    )
    baseline = _report(
        [
            _finding(
                category="images",
                page=3,
                title="Page 3 has a low-resolution image",
                detail="Image 0 on page 3 is drawn at 72 dpi.",
            )
        ]
    )

    result = compare_reports(current, baseline)

    assert _statuses(result) == ["moved"]
    assert result["summary"] == {**EMPTY_COUNTS, "moved": 1}
    entry = result["findings"][0]
    assert entry["current"]["page"] == 4
    assert entry["baseline"]["page"] == 3


def test_document_level_finding_moved_to_a_page_is_moved():
    result = compare_reports(
        _report([_finding(page=1)]),
        _report([_finding(page=None)]),
    )

    assert _statuses(result) == ["moved"]


def test_severity_increase_escalates_an_existing_finding():
    result = compare_reports(
        _report([_finding(severity="warning", page=3)]),
        _report([_finding(severity="info", page=3)]),
    )

    assert _statuses(result) == ["escalated"]
    assert result["summary"] == {**EMPTY_COUNTS, "escalated": 1}


def test_severity_increase_escalates_a_moved_finding():
    result = compare_reports(
        _report([_finding(severity="error", page=5)]),
        _report([_finding(severity="warning", page=3)]),
    )

    assert _statuses(result) == ["escalated"]
    assert result["summary"]["moved"] == 0


def test_severity_decrease_keeps_the_pair_as_existing():
    result = compare_reports(
        _report([_finding(severity="info", page=3)]),
        _report([_finding(severity="warning", page=3)]),
    )

    assert _statuses(result) == ["existing"]


def test_same_fingerprint_identity_wins_over_content_when_provided():
    fingerprint = "a" * 32
    result = compare_reports(
        _report([_finding(title="Current wording", fingerprint=fingerprint)]),
        _report([_finding(title="Old wording", fingerprint=fingerprint)]),
    )

    assert _statuses(result) == ["existing"]


def test_current_findings_keep_report_order_then_fixed_follow_baseline_order():
    current = _report(
        [
            _finding(title="Existing one", page=1),
            _finding(title="New one", page=2),
        ]
    )
    baseline = _report(
        [
            _finding(title="Fixed one", page=3),
            _finding(title="Existing one", page=1),
            _finding(title="Fixed two", page=4),
        ]
    )

    result = compare_reports(current, baseline)

    assert _statuses(result) == ["existing", "new", "fixed", "fixed"]
    assert [entry["fingerprint"] for entry in result["findings"][2:]] == [
        finding_fingerprint(_finding(title="Fixed one", page=3)),
        finding_fingerprint(_finding(title="Fixed two", page=4)),
    ]


# --- contract shape ---------------------------------------------------------


def test_comparison_has_the_documented_shape_and_order():
    result = compare_reports(
        _report([_finding(page=2)]),
        _report([], pages=3),
    )

    assert list(result) == [
        "schemaVersion",
        "tool",
        "current",
        "baseline",
        "summary",
        "findings",
    ]
    assert result["schemaVersion"] == 1
    assert result["tool"] == {"name": "pdf-inspector", "version": "0.3.3"}
    assert set(result["current"]) == {"pages", "findings"}
    assert set(result["baseline"]) == {"pages", "findings"}
    assert list(result["summary"]) == list(BASELINE_STATUSES)
    assert result["summary"]["waived"] == 0

    entry = result["findings"][0]
    assert list(entry) == ["status", "fingerprint", "current", "baseline"]
    assert HEX32.fullmatch(entry["fingerprint"])
    assert entry["current"]["fingerprint"] == entry["fingerprint"]
    assert entry["baseline"] is None


def test_legacy_findings_without_a_fingerprint_get_one():
    finding = _finding(title="Legacy", page=2)
    assert "fingerprint" not in finding

    result = compare_reports(
        _report([finding]),
        _report([_finding(title="Legacy", page=2)]),
    )

    entry = result["findings"][0]
    assert entry["status"] == "existing"
    assert entry["fingerprint"] == finding_fingerprint(finding)
    assert entry["current"]["fingerprint"] == finding_fingerprint(finding)
    assert entry["baseline"]["fingerprint"] == finding_fingerprint(finding)


def test_compare_does_not_mutate_its_inputs():
    current_finding = _finding(title="A")
    baseline_finding = _finding(title="B", page=2)
    current = _report([current_finding])
    baseline = _report([baseline_finding])
    current_before = copy.deepcopy(current)
    baseline_before = copy.deepcopy(baseline)

    compare_reports(current, baseline)

    assert current == current_before
    assert baseline == baseline_before
    assert "fingerprint" not in current_finding
    assert "fingerprint" not in baseline_finding


def test_comparison_is_deterministic_and_free_of_paths_and_timestamps():
    current = _report(
        [_finding(title=f"Finding {index}", page=index) for index in range(1, 4)]
    )
    baseline = _report([_finding(title="Finding 2", page=2)], pages=2)

    first = compare_reports(current, baseline)
    second = compare_reports(current, baseline)

    assert json.dumps(first) == json.dumps(second)
    payload = json.dumps(first)
    assert "/home/" not in payload and "/tmp/" not in payload
    assert not re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", payload)


def test_compare_tolerates_minimal_reports():
    result = compare_reports({"findings": []}, {"findings": []})

    assert result["current"] == {"pages": 0, "findings": 0}
    assert result["baseline"] == {"pages": 0, "findings": 0}
    assert result["tool"]["name"] == "pdf-inspector"
    assert result["summary"] == EMPTY_COUNTS


# --- load_baseline ----------------------------------------------------------


def test_load_baseline_accepts_an_audit_report_and_fills_legacy_fingerprints(tmp_path):
    path = tmp_path / "baseline.json"
    legacy = _finding(title="Legacy", page=2)
    _write(path, _report([legacy], pages=2))

    loaded = load_baseline(path)

    assert loaded["schemaVersion"] == 1
    assert loaded["document"]["pages"] == 2
    assert loaded["findings"][0]["fingerprint"] == finding_fingerprint(legacy)
    assert "fingerprint" not in legacy

    result = compare_reports(
        _report([_finding(title="Legacy", page=2)]),
        loaded,
    )
    assert _statuses(result) == ["existing"]


def test_load_baseline_prefers_an_existing_fingerprint(tmp_path):
    path = tmp_path / "baseline.json"
    fingerprint = "b" * 32
    _write(path, _report([_finding(fingerprint=fingerprint)]))

    loaded = load_baseline(path)

    assert loaded["findings"][0]["fingerprint"] == fingerprint


def test_load_baseline_rejects_a_missing_file(tmp_path):
    with pytest.raises(BaselineError, match="cannot read baseline file"):
        load_baseline(tmp_path / "missing.json")


def test_load_baseline_rejects_a_directory(tmp_path):
    with pytest.raises(BaselineError, match="cannot read baseline file"):
        load_baseline(tmp_path)


def test_load_baseline_rejects_a_url_without_a_network_request():
    with pytest.raises(BaselineError, match="local file path"):
        load_baseline("https://example.com/baseline.json")


def test_load_baseline_rejects_a_path_wrapped_url():
    # ``Path`` normalises ``https://`` to ``https:/``; the check must survive.
    with pytest.raises(BaselineError, match="local file path"):
        load_baseline(Path("https://example.com/baseline.json"))


@pytest.mark.parametrize(
    "payload, fragment",
    [
        ("not json", "is not valid JSON"),
        ("[]", "must contain a JSON object"),
        ('"report"', "must contain a JSON object"),
        ('{"schemaVersion": 2, "findings": []}', "must have schemaVersion 1"),
        ('{"findings": []}', "must have schemaVersion 1"),
        ('{"schemaVersion": true, "findings": []}', "must have schemaVersion 1"),
        ('{"schemaVersion": 1}', "must contain a findings array"),
        ('{"schemaVersion": 1, "findings": {}}', "must contain a findings array"),
        ('{"schemaVersion": 1, "findings": [1]}', "must be a JSON object"),
    ],
)
def test_load_baseline_rejects_malformed_reports(tmp_path, payload, fragment):
    path = tmp_path / "baseline.json"
    path.write_text(payload, encoding="utf-8")

    with pytest.raises(BaselineError) as excinfo:
        load_baseline(path)

    assert fragment in str(excinfo.value)


def test_load_baseline_rejects_a_baseline_comparison_artifact(tmp_path):
    current = _report([_finding(title="A", page=1), _finding(title="B", page=2)])
    comparison = compare_reports(current, _report([_finding(title="A", page=1)]))
    path = tmp_path / "comparison.json"
    path.write_text(json.dumps(comparison), encoding="utf-8")

    with pytest.raises(BaselineError) as excinfo:
        load_baseline(path)

    message = str(excinfo.value)
    assert "BaselineComparison" in message
    assert "--baseline-output" in message


def test_load_baseline_rejects_an_empty_comparison_artifact(tmp_path):
    # A degenerate comparison has no finding entries to inspect, so the
    # top-level current/baseline blocks are the only distinguishing signal.
    payload = {
        "schemaVersion": 1,
        "tool": {"name": "pdf-inspector", "version": "0.3.3"},
        "current": {"pages": 4, "findings": 0},
        "baseline": {"pages": 4, "findings": 0},
        "summary": {status: 0 for status in BASELINE_STATUSES},
        "findings": [],
    }
    path = tmp_path / "empty-comparison.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(BaselineError) as excinfo:
        load_baseline(path)

    message = str(excinfo.value)
    assert "BaselineComparison" in message
    assert "current, baseline" in message
    assert "--baseline-output" in message


@pytest.mark.parametrize(
    "overrides, fragment",
    [
        ({"category": "mystery"}, ".category"),
        ({"category": None}, ".category"),
        ({"severity": "fatal"}, ".severity"),
        ({"severity": None}, ".severity"),
        ({"title": None}, ".title"),
        ({"title": 5}, ".title"),
        ({"detail": None}, ".detail"),
        ({"detail": ["x"]}, ".detail"),
        ({"page": 0}, ".page"),
        ({"page": -1}, ".page"),
        ({"page": True}, ".page"),
        ({"page": "3"}, ".page"),
        ({"evidence": 1}, ".evidence"),
        ({"recommendation": ["x"]}, ".recommendation"),
    ],
)
def test_load_baseline_rejects_malformed_findings(
    tmp_path, overrides, fragment
):
    finding = _finding(title="Valid title", page=1)
    finding.update(overrides)
    report = _report([])
    report["findings"] = [finding]
    path = tmp_path / "baseline.json"
    path.write_text(json.dumps(report), encoding="utf-8")

    with pytest.raises(BaselineError) as excinfo:
        load_baseline(path)

    assert fragment in str(excinfo.value)


def test_load_baseline_accepts_a_security_report_finding(tmp_path):
    finding = _finding(
        category="security",
        severity="warning",
        page=None,
        title="Document is encrypted",
        detail="The document is encrypted.",
        evidence="encrypted=true",
        recommendation="Check the document permissions.",
    )
    path = tmp_path / "security.json"
    path.write_text(json.dumps(_report([finding])), encoding="utf-8")

    loaded = load_baseline(path)

    assert loaded["findings"][0]["category"] == "security"
    assert loaded["findings"][0]["fingerprint"] == finding_fingerprint(finding)


@pytest.mark.parametrize(
    "fingerprint",
    [
        "A" * 32,  # uppercase
        "a" * 40,  # too long
        "a" * 31,  # too short
        "g" * 32,  # not hex
        "0123456789abcdef0123456789abcde_",  # non-hex separator
    ],
)
def test_load_baseline_rejects_invalid_fingerprints(tmp_path, fingerprint):
    finding = _finding(title="A", page=1, fingerprint=fingerprint)
    report = _report([])
    report["findings"] = [finding]
    path = tmp_path / "baseline.json"
    path.write_text(json.dumps(report), encoding="utf-8")

    with pytest.raises(BaselineError) as excinfo:
        load_baseline(path)

    assert ".fingerprint" in str(excinfo.value)


def test_load_baseline_computes_an_empty_fingerprint(tmp_path):
    finding = _finding(title="A", page=1, fingerprint="")
    report = _report([])
    report["findings"] = [finding]
    path = tmp_path / "baseline.json"
    path.write_text(json.dumps(report), encoding="utf-8")

    loaded = load_baseline(path)

    assert loaded["findings"][0]["fingerprint"] == finding_fingerprint(finding)


# --- waivers ----------------------------------------------------------------

TODAY = date(2026, 6, 1)


def _waiver(
    finding=None,
    *,
    fingerprint=None,
    page=None,
    reason="Legacy template; tracked in DOC-1234",
    expires=date(2026, 12, 31),
) -> Waiver:
    if fingerprint is None:
        fingerprint = finding_fingerprint(finding if finding is not None else {})
    return Waiver(fingerprint=fingerprint, page=page, reason=reason, expires=expires)


def _apply(findings, *waivers) -> object:
    return apply_waivers(list(findings), list(waivers), today=TODAY)


def test_waived_overrides_new():
    finding = _finding(title="Brand new", page=2)
    waiver = _waiver(finding)

    result = compare_reports(
        _report([finding]), _report([]), _apply([finding], waiver)
    )

    assert _statuses(result) == ["waived"]
    assert result["summary"] == {**EMPTY_COUNTS, "waived": 1}
    assert result["waivers"] == {"applied": 1, "expired": 0, "unused": 0}


def test_waived_overrides_existing():
    finding = _finding(title="Known", page=2)
    waiver = _waiver(finding)

    result = compare_reports(
        _report([finding]),
        _report([copy.deepcopy(finding)]),
        _apply([finding], waiver),
    )

    assert _statuses(result) == ["waived"]
    assert result["summary"] == {**EMPTY_COUNTS, "waived": 1}
    # The baseline pair is preserved so the entry still shows its history.
    assert result["findings"][0]["baseline"]["page"] == 2


def test_waived_overrides_moved():
    current = _finding(title="Moved", page=5)
    previous = _finding(title="Moved", page=3)
    waiver = _waiver(current)

    result = compare_reports(
        _report([current]), _report([previous]), _apply([current], waiver)
    )

    assert _statuses(result) == ["waived"]
    assert result["summary"]["moved"] == 0
    assert result["findings"][0]["baseline"]["page"] == 3


def test_waived_overrides_escalated():
    current = _finding(title="Escalated", severity="error", page=3)
    previous = _finding(title="Escalated", severity="info", page=3)
    waiver = _waiver(current)

    result = compare_reports(
        _report([current]), _report([previous]), _apply([current], waiver)
    )

    assert _statuses(result) == ["waived"]
    assert result["summary"]["escalated"] == 0


def test_waived_entries_carry_the_reason_and_expiry_date():
    finding = _finding(title="Waived", page=2)
    waiver = _waiver(finding, page=2, reason="Tracked in DOC-1234", expires=date(2027, 1, 31))

    result = compare_reports(
        _report([finding]), _report([]), _apply([finding], waiver)
    )

    entry = result["findings"][0]
    assert list(entry) == ["status", "fingerprint", "current", "baseline", "waiver"]
    assert entry["waiver"] == {
        "reason": "Tracked in DOC-1234",
        "expires": "2027-01-31",
    }


def test_only_waived_entries_carry_a_waiver_block():
    waived = _finding(title="Waived", page=2)
    other = _finding(title="Other", page=3)
    waiver = _waiver(waived)

    result = compare_reports(
        _report([waived, other]), _report([]), _apply([waived, other], waiver)
    )

    assert "waiver" in result["findings"][0]
    assert "waiver" not in result["findings"][1]
    assert list(result["findings"][1]) == ["status", "fingerprint", "current", "baseline"]


def test_fixed_entries_are_never_waived():
    fixed = _finding(title="Removed from the PDF", page=4)
    current = _finding(title="Still here", page=2)
    # A waiver points at the fixed finding's fingerprint without a page: it is
    # unused, because no *current* finding carries that identity.
    waiver = _waiver(fixed)

    result = compare_reports(
        _report([current]),
        _report([fixed, copy.deepcopy(current)]),
        _apply([current], waiver),
    )

    assert _statuses(result) == ["existing", "fixed"]
    assert result["waivers"] == {"applied": 0, "expired": 0, "unused": 1}
    assert "waiver" not in result["findings"][1]


def test_comparison_with_waivers_has_the_documented_key_order():
    finding = _finding(page=2)
    waiver = _waiver(finding)

    result = compare_reports(
        _report([finding]), _report([]), _apply([finding], waiver)
    )

    assert list(result) == [
        "schemaVersion",
        "tool",
        "current",
        "baseline",
        "summary",
        "waivers",
        "findings",
    ]
    assert list(result["waivers"]) == ["applied", "expired", "unused"]
    assert list(result["summary"]) == list(BASELINE_STATUSES)
    assert result["summary"]["waived"] == result["waivers"]["applied"]


def test_expired_waivers_are_not_applied_and_restore_the_status():
    finding = _finding(title="Expired policy", page=2)
    waiver = _waiver(finding, expires=date(2000, 1, 1))

    result = compare_reports(
        _report([finding]), _report([]), _apply([finding], waiver)
    )

    assert _statuses(result) == ["new"]
    assert result["summary"] == {**EMPTY_COUNTS, "new": 1}
    assert result["waivers"] == {"applied": 0, "expired": 1, "unused": 0}
    assert "waiver" not in result["findings"][0]


def test_unused_waivers_are_counted_without_changing_statuses():
    finding = _finding(title="Real", page=2)
    waiver = _waiver(fingerprint="a" * 32, reason="Stale policy entry")

    result = compare_reports(
        _report([finding]), _report([]), _apply([finding], waiver)
    )

    assert _statuses(result) == ["new"]
    assert result["waivers"] == {"applied": 0, "expired": 0, "unused": 1}


def test_one_waiver_accepts_one_of_several_identical_findings():
    duplicate = _finding(title="Duplicate", page=2)
    findings = [duplicate, copy.deepcopy(duplicate)]
    waiver = _waiver(duplicate)

    result = compare_reports(
        _report(findings), _report([]), _apply(findings, waiver)
    )

    assert _statuses(result) == ["waived", "new"]
    assert result["summary"]["waived"] == 1
    assert result["summary"]["new"] == 1
    assert result["waivers"]["applied"] == 1


def test_compare_with_waivers_does_not_mutate_its_inputs():
    current_finding = _finding(title="A")
    baseline_finding = _finding(title="B", page=2)
    current = _report([current_finding])
    baseline = _report([baseline_finding])
    current_before = copy.deepcopy(current)
    baseline_before = copy.deepcopy(baseline)
    application = _apply([current_finding], _waiver(current_finding))

    compare_reports(current, baseline, application)

    assert current == current_before
    assert baseline == baseline_before
    assert "fingerprint" not in current_finding
    assert "waiver" not in current_finding


def test_comparison_without_waivers_is_byte_identical_to_the_pre_waiver_output():
    current = _report(
        [_finding(title=f"Finding {index}", page=index) for index in range(1, 4)]
    )
    baseline = _report([_finding(title="Finding 2", page=2)], pages=2)

    implicit = compare_reports(current, baseline)
    explicit = compare_reports(current, baseline, None)

    assert json.dumps(implicit) == json.dumps(explicit)
    assert "waivers" not in implicit
    assert all("waiver" not in entry for entry in implicit["findings"])


def test_comparison_with_waivers_is_deterministic_and_free_of_paths():
    finding = _finding(title="Waived", page=2)
    waiver = _waiver(finding, reason="Tracked in DOC-1234")

    first = compare_reports(
        _report([finding]), _report([]), _apply([finding], waiver)
    )
    second = compare_reports(
        _report([finding]), _report([]), _apply([finding], waiver)
    )

    assert json.dumps(first) == json.dumps(second)
    payload = json.dumps(first)
    assert "/home/" not in payload and "/tmp/" not in payload
    assert "waivers.json" not in payload
