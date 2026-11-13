"""Expiring finding waivers: strict parsing, matching, expiry and counters."""

from __future__ import annotations

import copy
import json
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import waivers as waivers_module  # noqa: E402
from audit import finding_fingerprint  # noqa: E402
from waivers import (  # noqa: E402
    WAIVER_KEYS,
    Waiver,
    WaiverApplication,
    WaiverError,
    apply_waivers,
    load_waivers,
)

FINGERPRINT = "0123456789abcdef0123456789abcdef"
OTHER_FINGERPRINT = "fedcba9876543210fedcba9876543210"
TODAY = date(2026, 6, 1)


# --- fixture builders -------------------------------------------------------


def _finding(
    *,
    category: str = "fonts",
    severity: str = "warning",
    page=3,
    title: str = "Title",
    detail: str = "Detail",
    evidence=None,
    fingerprint=None,
) -> dict:
    finding = {
        "category": category,
        "severity": severity,
        "page": page,
        "title": title,
        "detail": detail,
        "evidence": evidence,
        "recommendation": None,
    }
    if fingerprint is not None:
        finding["fingerprint"] = fingerprint
    return finding


def _entry(
    fingerprint: str = FINGERPRINT,
    *,
    page="absent",
    reason: str = "Legacy template; tracked in DOC-1234",
    expires: str = "2026-12-31",
    **extra,
) -> dict:
    entry = {"fingerprint": fingerprint}
    if page != "absent":
        entry["page"] = page
    entry["reason"] = reason
    entry["expires"] = expires
    entry.update(extra)
    return entry


def _write(path: Path, payload) -> str:
    path.write_text(
        payload if isinstance(payload, str) else json.dumps(payload),
        encoding="utf-8",
    )
    return str(path)


def _waiver_file(tmp_path: Path, *entries, name: str = "waivers.json") -> str:
    return _write(tmp_path / name, {"schemaVersion": 1, "waivers": list(entries)})


def _waiver(**overrides) -> Waiver:
    params = {
        "fingerprint": FINGERPRINT,
        "page": None,
        "reason": "Tracked in DOC-1234",
        "expires": date(2026, 12, 31),
    }
    params.update(overrides)
    return Waiver(**params)


# --- valid files ------------------------------------------------------------


def test_valid_file_parses_every_field(tmp_path):
    path = _waiver_file(
        tmp_path,
        _entry(page=7),
        _entry(fingerprint=OTHER_FINGERPRINT, reason="  Any page  "),
    )

    loaded = load_waivers(path)

    assert isinstance(loaded, tuple)
    assert len(loaded) == 2
    first, second = loaded
    assert isinstance(first, Waiver)
    assert first.fingerprint == FINGERPRINT
    assert first.page == 7
    assert first.reason == "Legacy template; tracked in DOC-1234"
    assert first.expires == date(2026, 12, 31)
    assert first.expires_text == "2026-12-31"
    assert second.page is None
    assert second.reason == "Any page"


def test_null_page_and_an_absent_page_both_mean_any_page(tmp_path):
    path = _waiver_file(
        tmp_path,
        {"fingerprint": FINGERPRINT, "page": None, "reason": "null page", "expires": "2026-01-01"},
    )

    assert load_waivers(path)[0].page is None


def test_empty_waivers_array_is_valid(tmp_path):
    path = _write(tmp_path / "waivers.json", {"schemaVersion": 1, "waivers": []})

    assert load_waivers(path) == ()


def test_today_is_accepted_but_does_not_filter_entries(tmp_path):
    path = _waiver_file(tmp_path, _entry(expires="2000-01-01"))

    assert len(load_waivers(path, today=TODAY)) == 1
    assert len(load_waivers(path, today=date(2999, 1, 1))) == 1


def test_as_dict_returns_the_documented_shape(tmp_path):
    waiver = _waiver(page=7)

    assert waiver.as_dict() == {
        "fingerprint": FINGERPRINT,
        "page": 7,
        "reason": "Tracked in DOC-1234",
        "expires": "2026-12-31",
    }
    assert list(waiver.as_dict()) == list(WAIVER_KEYS)


# --- invalid files ----------------------------------------------------------


@pytest.mark.parametrize(
    "payload, fragment",
    [
        ("not json", "is not valid JSON"),
        ("[]", "must contain a JSON object"),
        ('"waivers"', "must contain a JSON object"),
        ('{"waivers": []}', "must have schemaVersion 1"),
        ('{"schemaVersion": 2, "waivers": []}', "must have schemaVersion 1"),
        ('{"schemaVersion": true, "waivers": []}', "must have schemaVersion 1"),
        ('{"schemaVersion": "1", "waivers": []}', "must have schemaVersion 1"),
        ('{"schemaVersion": 1}', "must contain a waivers array"),
        ('{"schemaVersion": 1, "waivers": {}}', "must contain a waivers array"),
        ('{"schemaVersion": 1, "waivers": [1]}', "waivers[1] must be a JSON object"),
        ('{"schemaVersion": 1, "waivers": ["x"]}', "waivers[1] must be a JSON object"),
    ],
)
def test_malformed_documents_are_rejected(tmp_path, payload, fragment):
    path = _write(tmp_path / "waivers.json", payload)

    with pytest.raises(WaiverError) as excinfo:
        load_waivers(path)

    assert fragment in str(excinfo.value)


def test_unknown_keys_are_rejected(tmp_path):
    path = _waiver_file(tmp_path, _entry(note="not allowed"))

    with pytest.raises(WaiverError, match="unknown key"):
        load_waivers(path)


@pytest.mark.parametrize(
    "fingerprint",
    [
        "",
        "0123456789ABCDEF0123456789ABCDEF",  # uppercase
        "0123456789abcdef0123456789abcde",  # 31 chars
        "0123456789abcdef0123456789abcdeff",  # 33 chars
        "0123456789abcdef0123456789abcdeg",  # not hex
        "sha256:0123456789abcdef012345678",  # decorated
        None,
        123,
    ],
)
def test_invalid_fingerprints_are_rejected(tmp_path, fingerprint):
    path = _waiver_file(tmp_path, _entry(fingerprint))

    with pytest.raises(WaiverError, match=r"\.fingerprint must be 32 lowercase hex"):
        load_waivers(path)


@pytest.mark.parametrize("page", [0, -1, 1.5, "3", True, False, [], {}])
def test_invalid_pages_are_rejected(tmp_path, page):
    path = _waiver_file(tmp_path, _entry(page=page))

    with pytest.raises(WaiverError, match=r"\.page must be a positive integer"):
        load_waivers(path)


def test_a_boolean_page_is_not_an_integer(tmp_path):
    """``True == 1`` in Python; a JSON boolean must still be rejected."""
    path = _waiver_file(
        tmp_path,
        {"fingerprint": FINGERPRINT, "page": True, "reason": "bool", "expires": "2026-01-01"},
    )

    with pytest.raises(WaiverError, match=r"\.page must be a positive integer"):
        load_waivers(path)


@pytest.mark.parametrize("reason", ["", "  ", " ab ", "a", None, 3, [], {}])
def test_invalid_reasons_are_rejected(tmp_path, reason):
    path = _waiver_file(tmp_path, _entry(reason=reason))

    with pytest.raises(WaiverError, match=r"\.reason must be a non-empty string"):
        load_waivers(path)


def test_a_missing_reason_is_rejected(tmp_path):
    entry = _entry()
    del entry["reason"]
    path = _waiver_file(tmp_path, entry)

    with pytest.raises(WaiverError, match=r"\.reason must be a non-empty string"):
        load_waivers(path)


@pytest.mark.parametrize(
    "expires",
    [
        "",
        "2026-1-1",
        "2026/12/31",
        "20261231",
        "2026-12-31T00:00:00",
        "2026-13-01",
        "2026-02-30",
        "not-a-date",
        None,
        20261231,
    ],
)
def test_invalid_expiry_dates_are_rejected(tmp_path, expires):
    path = _waiver_file(tmp_path, _entry(expires=expires))

    with pytest.raises(WaiverError, match=r"\.expires"):
        load_waivers(path)


def test_a_missing_expiry_is_rejected(tmp_path):
    entry = _entry()
    del entry["expires"]
    path = _waiver_file(tmp_path, entry)

    with pytest.raises(WaiverError, match=r"\.expires must be a YYYY-MM-DD"):
        load_waivers(path)


def test_duplicate_fingerprint_and_page_is_an_error(tmp_path):
    path = _waiver_file(tmp_path, _entry(page=7), _entry(page=7))

    with pytest.raises(WaiverError, match="same fingerprint\\+page twice"):
        load_waivers(path)


def test_duplicate_any_page_waivers_are_an_error(tmp_path):
    """An absent ``page`` and ``page: null`` are the same (any-page) key."""
    path = _waiver_file(
        tmp_path,
        _entry(),
        {"fingerprint": FINGERPRINT, "page": None, "reason": "again", "expires": "2026-01-01"},
    )

    with pytest.raises(WaiverError, match="same fingerprint\\+page twice"):
        load_waivers(path)


def test_the_same_fingerprint_on_distinct_pages_is_allowed(tmp_path):
    path = _waiver_file(tmp_path, _entry(page=3), _entry(page=4), _entry())

    assert len(load_waivers(path)) == 3


def test_missing_file_directory_and_url_are_rejected(tmp_path):
    with pytest.raises(WaiverError, match="cannot read waivers file"):
        load_waivers(tmp_path / "missing.json")

    with pytest.raises(WaiverError, match="cannot read waivers file"):
        load_waivers(tmp_path)

    with pytest.raises(WaiverError, match="local file path"):
        load_waivers("https://example.com/waivers.json")

    # ``Path`` normalises ``https://`` to ``https:/``; the check must survive.
    with pytest.raises(WaiverError, match="local file path"):
        load_waivers(Path("https://example.com/waivers.json"))


def test_waiver_error_is_a_value_error():
    assert issubclass(WaiverError, ValueError)


# --- expiry -----------------------------------------------------------------


def test_expiry_is_inclusive_on_the_date_and_expired_the_next_day():
    waiver = _waiver(expires=date(2026, 6, 1))
    findings = [_finding(fingerprint=FINGERPRINT)]

    on_the_day = apply_waivers(findings, [waiver], today=date(2026, 6, 1))
    assert on_the_day.applied == {0: waiver}
    assert on_the_day.expired == ()
    assert on_the_day.unused == ()

    day_before = apply_waivers(findings, [waiver], today=date(2026, 5, 31))
    assert day_before.applied == {0: waiver}

    next_day = apply_waivers(findings, [waiver], today=date(2026, 6, 2))
    assert next_day.applied == {}
    assert next_day.expired == (waiver,)
    assert next_day.unused == ()


def test_expired_waivers_are_not_counted_as_unused():
    waiver = _waiver(expires=date(2000, 1, 1))

    result = apply_waivers([_finding(fingerprint=OTHER_FINGERPRINT)], [waiver], today=TODAY)

    assert result.expired == (waiver,)
    assert result.unused == ()
    assert result.counts == {"applied": 0, "expired": 1, "unused": 0}


def test_is_expired_compares_calendar_dates():
    waiver = _waiver(expires=date(2026, 6, 1))

    assert waiver.is_expired(date(2026, 5, 31)) is False
    assert waiver.is_expired(date(2026, 6, 1)) is False
    assert waiver.is_expired(date(2026, 6, 2)) is True


def test_default_today_uses_the_utc_date(monkeypatch):
    calls = []

    def fake_today():
        calls.append(True)
        return date(2026, 6, 2)

    monkeypatch.setattr(waivers_module, "utc_today", fake_today)
    waiver = _waiver(expires=date(2026, 6, 1))

    result = apply_waivers([_finding(fingerprint=FINGERPRINT)], [waiver])

    assert calls == [True]
    assert result.expired == (waiver,)


# --- matching ---------------------------------------------------------------


def test_any_page_waiver_matches_a_finding_on_any_page():
    waiver = _waiver(page=None)

    result = apply_waivers(
        [
            _finding(page=1, fingerprint=FINGERPRINT),
            _finding(page=9, fingerprint=OTHER_FINGERPRINT, title="Other"),
        ],
        [waiver],
        today=TODAY,
    )

    assert result.applied == {0: waiver}
    assert result.unused == ()


def test_page_specific_waiver_only_matches_that_page():
    waiver = _waiver(page=7)

    matched = apply_waivers([_finding(page=7, fingerprint=FINGERPRINT)], [waiver], today=TODAY)
    assert matched.applied == {0: waiver}

    missed = apply_waivers([_finding(page=8, fingerprint=FINGERPRINT)], [waiver], today=TODAY)
    assert missed.applied == {}
    assert missed.unused == (waiver,)


def test_page_specific_waiver_does_not_match_a_document_level_finding():
    waiver = _waiver(page=1)

    result = apply_waivers([_finding(page=None, fingerprint=FINGERPRINT)], [waiver], today=TODAY)

    assert result.applied == {}
    assert result.unused == (waiver,)


def test_matching_uses_the_fingerprint_only_not_the_summary_text():
    finding = _finding(page=4, title="Reworded later", fingerprint=FINGERPRINT)
    waiver = _waiver()

    result = apply_waivers([finding], [waiver], today=TODAY)

    assert result.applied == {0: waiver}


def test_a_finding_without_a_fingerprint_gets_the_engine_one():
    finding = _finding()
    assert "fingerprint" not in finding
    waiver = _waiver(fingerprint=finding_fingerprint(finding))

    result = apply_waivers([finding], [waiver], today=TODAY)

    assert result.applied == {0: waiver}


def test_one_waiver_accepts_only_the_first_of_several_matching_findings():
    waiver = _waiver()
    findings = [
        _finding(page=1, fingerprint=FINGERPRINT),
        _finding(page=2, fingerprint=FINGERPRINT),
    ]

    result = apply_waivers(findings, [waiver], today=TODAY)

    assert result.applied == {0: waiver}
    assert result.unused == ()


def test_one_finding_matches_at_most_one_waiver():
    first = _waiver(reason="First policy", expires=date(2026, 12, 31))
    second = _waiver(reason="Second policy", expires=date(2026, 12, 31))

    result = apply_waivers([_finding(fingerprint=FINGERPRINT)], [first, second], today=TODAY)

    assert result.applied == {0: first}
    assert result.unused == (second,)


def test_unmatched_waivers_are_unused():
    matched = _waiver(fingerprint=FINGERPRINT)
    unmatched = _waiver(fingerprint=OTHER_FINGERPRINT)

    result = apply_waivers([_finding(fingerprint=FINGERPRINT)], [matched, unmatched], today=TODAY)

    assert result.applied == {0: matched}
    assert result.unused == (unmatched,)


def test_apply_waivers_does_not_mutate_the_findings():
    finding = _finding(fingerprint=FINGERPRINT, page=3)
    before = copy.deepcopy(finding)

    apply_waivers([finding], [_waiver(page=3)], today=TODAY)

    assert finding == before
    assert list(finding) == list(before)


def test_apply_waivers_ignores_non_mapping_entries():
    waiver = _waiver()

    result = apply_waivers([None, _finding(fingerprint=FINGERPRINT)], [waiver], today=TODAY)

    assert result.applied == {1: waiver}


def test_counts_and_indices_are_stable():
    waivers = [
        _waiver(fingerprint=FINGERPRINT, page=1, reason="A"),
        _waiver(fingerprint=OTHER_FINGERPRINT, page=2, reason="B"),
        _waiver(fingerprint="1" * 32, reason="unused"),
    ]
    findings = [
        _finding(page=2, fingerprint=OTHER_FINGERPRINT),
        _finding(page=1, fingerprint=FINGERPRINT),
    ]

    result = apply_waivers(findings, waivers, today=TODAY)

    assert isinstance(result, WaiverApplication)
    assert result.applied == {0: waivers[1], 1: waivers[0]}
    assert result.applied_count == 2
    assert result.expired_count == 0
    assert result.unused_count == 1
    assert result.counts == {"applied": 2, "expired": 0, "unused": 1}
    assert [waiver.reason for waiver in result.applied_waivers()] == ["B", "A"]


def test_empty_inputs_yield_empty_counts():
    result = apply_waivers([], [], today=TODAY)

    assert result.applied == {}
    assert result.expired == ()
    assert result.unused == ()
    assert result.counts == {"applied": 0, "expired": 0, "unused": 0}
