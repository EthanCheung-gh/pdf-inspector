"""Stable audit finding fingerprints: algorithm, inputs and engine coverage."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import audit  # noqa: E402
from audit import (  # noqa: E402
    FINDING_KEYS,
    FINDING_OUTPUT_KEYS,
    FINGERPRINT_KEY,
    audit_file,
    finding_fingerprint,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
# A committed sample, so the engine integration test also runs in CI before
# `scripts/generate-web-samples.py` creates the ignored web samples.
BASIC_PDF = REPO_ROOT / "web-samples" / "accessibility-broken.pdf"

HEX32 = re.compile(r"[0-9a-f]{32}")


def _finding(**overrides) -> dict:
    finding = {
        "category": "fonts",
        "severity": "warning",
        "page": 3,
        "title": "Font not embedded: X",
        "detail": "Font X has no embedded font program.",
        "evidence": None,
        "recommendation": "Embed the font.",
    }
    finding.update(overrides)
    return finding


# --- algorithm --------------------------------------------------------------


def test_fingerprint_is_32_lowercase_hex_characters():
    fingerprint = finding_fingerprint(_finding())

    assert HEX32.fullmatch(fingerprint)
    assert len(fingerprint) == 32
    assert fingerprint == fingerprint.lower()


def test_fingerprint_matches_the_documented_payload():
    finding = _finding()
    payload = (
        "pdf-inspector-finding-v1\x1f"
        "fonts\x1f"
        "Font not embedded: X\x1f"
        "Font X has no embedded font program.\x1f"
    )
    expected = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]

    assert finding_fingerprint(finding) == expected
    # Pinned vector: a wording or separator change must be a deliberate bump.
    assert expected == "157208e39a4cab6e1ceabe219022628c"


def test_fingerprint_ignores_page_severity_and_recommendation():
    base = finding_fingerprint(_finding())

    assert finding_fingerprint(_finding(page=None)) == base
    assert finding_fingerprint(_finding(page=99)) == base
    assert finding_fingerprint(_finding(severity="error")) == base
    assert finding_fingerprint(_finding(severity="info")) == base
    assert finding_fingerprint(_finding(recommendation="Different advice.")) == base
    assert finding_fingerprint(_finding(recommendation=None)) == base


def test_fingerprint_changes_with_every_hashed_field():
    base = finding_fingerprint(_finding())

    assert finding_fingerprint(_finding(category="pages")) != base
    assert finding_fingerprint(_finding(title="Font not embedded: Y")) != base
    assert finding_fingerprint(_finding(detail="Different detail.")) != base
    assert finding_fingerprint(_finding(evidence="subtype=TrueType")) != base


def test_none_and_empty_values_are_the_same_identity():
    assert finding_fingerprint(_finding(evidence=None)) == finding_fingerprint(
        _finding(evidence="")
    )
    assert finding_fingerprint(_finding(title="")) != finding_fingerprint(_finding())
    # ``None`` never raises and hashes as the empty string.
    assert finding_fingerprint(
        {"category": None, "title": None, "detail": None, "evidence": None}
    ) == finding_fingerprint(
        {"category": "", "title": "", "detail": "", "evidence": ""}
    )


def test_fingerprint_accepts_a_finding_with_missing_keys():
    fingerprint = finding_fingerprint({})

    payload = "pdf-inspector-finding-v1\x1f\x1f\x1f\x1f"
    assert fingerprint == hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


# --- page-reference normalisation -------------------------------------------


def test_page_references_to_the_findings_own_page_are_normalized():
    page_three = _finding(
        category="images",
        page=3,
        title="Page 3 has a low-resolution image",
        detail="Image 0 on page 3 is drawn at 72 dpi.",
        evidence="pixels 8 x 8",
    )
    page_four = _finding(
        category="images",
        page=4,
        title="Page 4 has a low-resolution image",
        detail="Image 0 on page 4 is drawn at 72 dpi.",
        evidence="pixels 8 x 8",
    )

    assert finding_fingerprint(page_three) == finding_fingerprint(page_four)


def test_page_normalization_matches_the_documented_payload():
    finding = _finding(
        category="images",
        page=3,
        title="Page 3 has a low-resolution image",
        detail="Image 0 on page 3 is drawn at 72 dpi.",
        evidence="pixels 8 x 8",
    )
    payload = (
        "pdf-inspector-finding-v1\x1f"
        "images\x1f"
        "Page # has a low-resolution image\x1f"
        "Image 0 on page # is drawn at 72 dpi.\x1f"
        "pixels 8 x 8"
    )
    expected = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]

    assert finding_fingerprint(finding) == expected
    # Pinned vector for the normalised payload; the plain vector above is
    # unchanged because that finding has no page reference in its text.
    assert expected == "2cbc34c8cd1877e1d52b2e27b01c76a7"


def test_only_the_findings_own_page_number_is_normalized():
    base = _finding(
        page=3,
        title="Page 3 has a low-resolution image",
        detail="Page 9 is also affected.",
    )
    other_number = _finding(
        page=3,
        title="Page 3 has a low-resolution image",
        detail="Page 10 is also affected.",
    )
    moved = _finding(
        page=4,
        title="Page 4 has a low-resolution image",
        detail="Page 9 is also affected.",
    )

    assert finding_fingerprint(base) != finding_fingerprint(other_number)
    assert finding_fingerprint(base) == finding_fingerprint(moved)


def test_page_normalization_preserves_the_case_of_the_word():
    upper = _finding(page=3, title="Page 3 is blank", detail="")
    lower = _finding(page=3, title="page 3 is blank", detail="")

    assert finding_fingerprint(upper) != finding_fingerprint(lower)
    assert finding_fingerprint(upper) == finding_fingerprint(
        _finding(page=7, title="Page 7 is blank", detail="")
    )
    assert finding_fingerprint(lower) == finding_fingerprint(
        _finding(page=7, title="page 7 is blank", detail="")
    )


def test_document_level_findings_are_not_page_normalized():
    base = _finding(
        page=None,
        title="Mixed page sizes",
        detail="Page 1 is letter, page 2 is A4.",
    )
    normalized_text = _finding(
        page=None,
        title="Mixed page sizes",
        detail="Page # is letter, page 2 is A4.",
    )
    same = _finding(
        page=None,
        title="Mixed page sizes",
        detail="Page 1 is letter, page 2 is A4.",
    )

    assert finding_fingerprint(base) != finding_fingerprint(normalized_text)
    assert finding_fingerprint(base) == finding_fingerprint(same)


def test_version_prefix_is_part_of_the_identity(monkeypatch):
    finding = _finding()
    before = finding_fingerprint(finding)

    monkeypatch.setattr(audit, "FINGERPRINT_VERSION", "pdf-inspector-finding-v2")

    assert finding_fingerprint(finding) != before


# --- engine integration -----------------------------------------------------


def test_finding_appends_the_fingerprint_after_the_contract_keys():
    finding = audit._finding(
        "fonts", "warning", 3, "Title", "Detail", "evidence", "recommendation"
    )

    assert list(finding) == [*FINDING_KEYS, FINGERPRINT_KEY]
    assert list(finding) == list(FINDING_OUTPUT_KEYS)
    assert finding[FINGERPRINT_KEY] == finding_fingerprint(finding)
    assert HEX32.fullmatch(finding[FINGERPRINT_KEY])


def test_engine_findings_carry_stable_fingerprints():
    first = audit_file(BASIC_PDF)
    second = audit_file(BASIC_PDF)

    assert first["findings"], "the sample must produce at least one finding"
    assert [item[FINGERPRINT_KEY] for item in first["findings"]] == [
        item[FINGERPRINT_KEY] for item in second["findings"]
    ]
    for finding in first["findings"]:
        assert set(finding) == set(FINDING_KEYS) | {FINGERPRINT_KEY}
        assert HEX32.fullmatch(finding[FINGERPRINT_KEY])
        assert finding[FINGERPRINT_KEY] == finding_fingerprint(finding)
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
