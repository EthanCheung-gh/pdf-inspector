"""Accessibility findings, the Audit merge and the committed samples.

Hand-built resource dicts pin every check's level, title, page and evidence
without needing a synthetic PDF per condition.  The two committed samples pin
the real pdfminer path end to end: they must open in pdfplumber, produce exactly
the expected findings and stay byte-identical when regenerated.
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import audit  # noqa: E402
from audit import (  # noqa: E402
    AUDIT_CATEGORIES,
    FINDING_KEYS,
    FINGERPRINT_KEY,
    accessibility_findings,
    accessibility_report,
    audit_document,
    audit_file,
)
from extractor import PdfExtractor  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLES = REPO_ROOT / "web-samples"
GENERATOR = REPO_ROOT / "scripts" / "generate-accessibility-samples.py"

DOCUMENT_KEYS = {
    "pages",
    "version",
    "encrypted",
    "tagged",
    "hasStructTreeRoot",
    "hasParentTree",
    "language",
    "title",
    "roleMap",
    "truncated",
    "skipped",
}

BROKEN_TITLES = [
    "Structure tree has no ParentTree",
    "Figure has no alternative text",
    "Heading levels are skipped",
    "List has no list items",
    "Table has no rows",
]


# --- builders ---------------------------------------------------------------


def _node(role, node_id="0", page=1, kind="element", raw_role=None, **extra):
    node = {
        "id": node_id,
        "kind": kind,
        "role": role,
        "rawRole": role if raw_role is None and kind == "element" else raw_role,
        "title": None,
        "alt": None,
        "actualText": None,
        "lang": None,
        "page": page,
        "mcid": None,
        "objectNumber": None,
        "attributes": {},
        "children": [],
        "truncated": False,
    }
    if kind == "mcid":
        node["mcid"] = 0
        node["rawRole"] = None
    node.update(extra)
    return node


def _document(**overrides):
    document = {
        "pages": 1,
        "version": "1.7",
        "encrypted": False,
        "tagged": True,
        "hasStructTreeRoot": True,
        "hasParentTree": True,
        "language": "en-US",
        "title": None,
        "roleMap": {},
        "truncated": False,
        "skipped": 0,
    }
    document.update(overrides)
    return document


def _findings(structure=None, truncation=None, **document):
    """Run the checks with the page-presence fact a clean document would have."""
    doc = _document(**document)
    facts = dict(truncation or {})
    if (
        doc.get("hasParentTree")
        and doc.get("pages")
        and "pagesWithStructParents" not in facts
    ):
        facts["pagesWithStructParents"] = doc["pages"]
    return accessibility_findings(
        {"document": doc, "structure": structure or []}, facts
    )


def _by_title(findings):
    return {finding["title"]: finding for finding in findings}


def _titles(findings):
    return [finding["title"] for finding in findings]


def _report(path):
    extractor = PdfExtractor(str(path))
    try:
        return accessibility_report(extractor)
    finally:
        extractor.close()


def _audit_document(path):
    extractor = PdfExtractor(str(path))
    try:
        return audit_document(extractor)
    finally:
        extractor.close()


def _write_pdf_objects(path, objects):
    """Write a minimal PDF with numbered (1-based) uncompressed objects."""
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref_position = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += (
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, xref_position)
    )
    path.write_bytes(bytes(out))
    return str(path)


def _write_untagged_pdf(path):
    """A one-page untagged PDF with no info dictionary entries."""
    return _write_pdf_objects(
        path,
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R >>",
            b"<< /Length 0 >>\nstream\n\nendstream",
        ],
    )


def _write_missing_struct_parents_pdf(path):
    """A tagged page with a ParentTree but no page ``/StructParents``."""
    return _write_pdf_objects(
        path,
        [
            b"<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 5 0 R "
            b"/MarkInfo << /Marked true >> /Lang (en-US) >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R >>",
            b"<< /Length 3 >>\nstream\nq Q\nendstream",
            b"<< /Type /StructTreeRoot /K [6 0 R] /ParentTree 7 0 R >>",
            b"<< /Type /StructElem /S /Document /Pg 3 0 R /K [8 0 R] >>",
            b"<< /Nums [] >>",
            b"<< /Type /StructElem /S /P /Pg 3 0 R /K 0 >>",
        ],
    )


def _load_generator():
    spec = importlib.util.spec_from_file_location(
        "generate_accessibility_samples", GENERATOR
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- tagging ----------------------------------------------------------------


def test_untagged_document_is_one_info_finding():
    findings = accessibility_findings(
        {
            "document": _document(
                tagged=False, hasStructTreeRoot=False, hasParentTree=False
            ),
            "structure": [],
        }
    )

    assert _titles(findings) == ["PDF is not tagged"]
    finding = findings[0]
    assert finding["category"] == "structure"
    assert finding["severity"] == "info"
    assert finding["page"] is None
    assert finding["detail"].startswith("No /StructTreeRoot")
    assert "No readable" not in finding["detail"]


def test_unreadable_struct_tree_root_softens_the_not_tagged_detail():
    findings = accessibility_findings(
        {
            "document": {"tagged": False, "hasStructTreeRoot": True},
            "structure": [],
        }
    )

    assert _titles(findings) == ["PDF is not tagged"]
    detail = findings[0]["detail"]
    assert detail.startswith("No readable /StructTreeRoot")
    assert "No /StructTreeRoot" not in detail


def test_not_tagged_is_never_duplicated_and_skips_tree_checks():
    findings = accessibility_findings(
        {
            "document": {"tagged": False},
            "structure": [
                _node(
                    "Document",
                    "0",
                    children=[_node("Figure", "0/0"), _node("L", "0/1")],
                )
            ],
        }
    )

    assert _titles(findings) == ["PDF is not tagged"]
    assert len(findings) == 1


def test_non_mapping_resources_degrade_to_the_not_tagged_hint():
    assert _titles(accessibility_findings(None)) == ["PDF is not tagged"]


def test_markinfo_only_document_does_not_get_a_parent_tree_finding():
    findings = _findings(hasStructTreeRoot=False, hasParentTree=False)

    assert findings == []


# --- ParentTree and page entries -------------------------------------------


def test_missing_parent_tree_is_a_warning():
    findings = _findings(hasParentTree=False)
    finding = _by_title(findings)["Structure tree has no ParentTree"]

    assert finding["severity"] == "warning"
    assert finding["page"] is None
    assert finding["evidence"] == "hasStructTreeRoot=true; hasParentTree=false"


def test_pages_missing_struct_parents_use_the_total_for_truncation():
    findings = _findings(
        pages=25,
        truncation={
            "pagesMissingStructParents": list(range(1, 11)),
            "pagesMissingStructParentsTotal": 25,
        },
    )

    assert len(findings) == audit.MAX_PAGE_FINDINGS
    assert _titles(findings) == [
        f"Page {page} has no structure parent entry"
        for page in range(1, audit.MAX_PAGE_FINDINGS + 1)
    ]
    for page, finding in enumerate(findings, start=1):
        assert finding["severity"] == "warning"
        assert finding["page"] == page
    assert findings[0]["evidence"] == (
        "pages=25; pagesMissingStructParents=10; "
        "pagesMissingStructParentsTotal=25; listed=10"
    )
    assert (
        "Only the first 10 of 25 affected pages are listed"
        in findings[0]["detail"]
    )
    assert (
        "Only the first 10 of 25 affected pages are listed"
        in findings[-1]["detail"]
    )


def test_pages_missing_struct_parents_total_falls_back_to_the_list_length():
    # A record from a collector without the total fact still reports a bound.
    missing = list(range(2, 31, 2))  # 15 pages, longer than the 10-page cap
    findings = _findings(
        pages=40,
        truncation={"pagesMissingStructParents": missing},
    )

    assert [finding["page"] for finding in findings] == missing[
        : audit.MAX_PAGE_FINDINGS
    ]
    assert findings[0]["evidence"] == (
        "pages=40; pagesMissingStructParents=15; listed=10"
    )
    assert (
        "Only the first 10 of 15 affected pages are listed"
        in findings[0]["detail"]
    )


def test_pages_missing_struct_parents_total_must_be_sane():
    # A total below the listed pages (or above the page count) is ignored.
    findings = _findings(
        pages=4,
        truncation={
            "pagesMissingStructParents": [1, 2, 3],
            "pagesMissingStructParentsTotal": 2,
        },
    )
    assert findings[0]["evidence"] == (
        "pages=4; pagesMissingStructParents=3; listed=3"
    )
    assert "Only the first" not in findings[0]["detail"]

    findings = _findings(
        pages=4,
        truncation={
            "pagesMissingStructParents": [1, 2],
            "pagesMissingStructParentsTotal": 99,
        },
    )
    assert findings[0]["evidence"] == (
        "pages=4; pagesMissingStructParents=2; listed=2"
    )


def test_absent_missing_struct_parents_fact_means_no_finding():
    resources = {"document": _document(pages=2), "structure": []}

    # The collector emits the fact only when a ParentTree document has a
    # content page without /StructParents; absence is authoritative.
    assert accessibility_findings(resources, {}) == []
    assert accessibility_findings(resources, None) == []
    # A count of pages with entries never triggers the page check by itself.
    assert accessibility_findings(resources, {"pagesWithStructParents": 0}) == []
    assert accessibility_findings(resources, {"pagesWithStructParents": 1}) == []


def test_pages_missing_struct_parents_fact_names_the_exact_pages():
    findings = _findings(
        pages=4,
        truncation={
            "pagesWithStructParents": 2,
            "pagesMissingStructParents": [4, 2, 9, 2],
        },
    )

    assert _titles(findings) == [
        "Page 2 has no structure parent entry",
        "Page 4 has no structure parent entry",
    ]
    assert [finding["page"] for finding in findings] == [2, 4]
    assert findings[0]["evidence"] == (
        "pages=4; pagesMissingStructParents=2; listed=2"
    )


def test_pages_missing_struct_parents_fact_is_bounded():
    missing = list(range(2, 31, 2))
    findings = _findings(
        pages=40,
        truncation={"pagesMissingStructParents": missing},
    )

    assert [finding["page"] for finding in findings] == missing[
        : audit.MAX_PAGE_FINDINGS
    ]
    assert (
        "Only the first 10 of 15 affected pages are listed"
        in findings[0]["detail"]
    )


def test_empty_or_unreadable_pages_missing_fact_does_not_guess():
    # An explicit empty list means the collector checked and no page is missing.
    assert (
        _findings(pages=2, truncation={"pagesMissingStructParents": []}) == []
    )
    # A present but unreadable fact skips the check instead of guessing.
    assert (
        _findings(pages=2, truncation={"pagesMissingStructParents": "2,4"}) == []
    )


def test_real_collector_reports_the_missing_struct_parents_page(tmp_path):
    path = _write_missing_struct_parents_pdf(tmp_path / "missing.pdf")
    report = _report(path)

    page_findings = [
        finding
        for finding in report["findings"]
        if finding["title"].startswith("Page ")
    ]
    assert len(page_findings) == 1
    finding = page_findings[0]
    assert finding["title"] == "Page 1 has no structure parent entry"
    assert finding["severity"] == "warning"
    assert finding["page"] == 1
    assert "pagesMissingStructParents=1" in finding["evidence"]
    assert "listed=1" in finding["evidence"]
    assert report["summary"]["total"] == 1


def test_no_pages_means_no_page_finding():
    assert (
        _findings(pages=0, truncation={"pagesMissingStructParents": [1]}) == []
    )


# --- roles ------------------------------------------------------------------


def test_structure_element_without_role_is_a_warning():
    findings = _findings(
        [_node("", "0", page=2, raw_role=None), _node("P", "1", page=3)]
    )
    finding = _by_title(findings)["Structure element has no role"]

    assert finding["severity"] == "warning"
    assert finding["page"] == 2
    assert finding["evidence"] == "nodes=0 (?, page 2)"
    assert "1 node affected" in finding["detail"]


def test_unknown_roles_are_named_and_rolemap_roles_are_exempt():
    structure = [
        _node(
            "Document",
            "0",
            children=[
                _node("CustomRole", "0/0", page=1),
                _node("H1", "0/1", page=2, raw_role="Alias"),
                _node("P", "0/2", page=3),
            ],
        )
    ]

    findings = _findings(structure, roleMap={"Alias": "H1"})

    assert _titles(findings) == ["Unknown structure role: CustomRole"]
    finding = findings[0]
    assert finding["severity"] == "warning"
    assert finding["page"] == 1
    assert finding["evidence"] == "nodes=0/0 (CustomRole, page 1)"


def test_rolemap_targets_are_not_unknown_roles():
    structure = [
        _node(
            "Document",
            "0",
            children=[_node("Weird", "0/0", raw_role="Alias")],
        )
    ]

    assert _findings(structure, roleMap={"Alias": "Weird"}) == []


def test_mcid_and_objr_placeholders_are_never_unknown_roles():
    structure = [
        _node(
            "Document",
            "0",
            children=[
                _node(
                    "Figure",
                    "0/0",
                    alt="A chart",
                    children=[
                        _node("MCID", "0/0/0", kind="mcid", raw_role=None)
                    ],
                ),
                _node("OBJR", "0/1", kind="object", raw_role=None),
            ],
        )
    ]

    findings = _findings(structure)

    assert findings == []
    assert not any(
        "MCID" in title or "OBJR" in title for title in _titles(findings)
    )


def test_unknown_role_names_are_capped_with_a_summary():
    extra = 2
    children = [
        _node(f"Custom{index:02d}", f"0/{index}")
        for index in range(audit.MAX_UNKNOWN_ROLE_FINDINGS + extra)
    ]
    findings = _findings([_node("Document", "0", children=children)])
    titles = _titles(findings)

    individual = [
        title for title in titles if title.startswith("Unknown structure role: ")
    ]
    assert len(individual) == audit.MAX_UNKNOWN_ROLE_FINDINGS
    assert "Unknown structure roles" in titles
    summary = findings[titles.index("Unknown structure roles")]
    assert f"{extra} more role name(s)" in summary["detail"]
    assert summary["page"] is None


def test_rolemap_cycle_is_a_warning():
    findings = _findings(
        [_node("LoopA", "0", raw_role="LoopA")],
        truncation={"roleMapCycles": 1},
        roleMap={"LoopA": "LoopB", "LoopB": "LoopA"},
    )

    assert _titles(findings) == ["RoleMap cycle"]
    finding = findings[0]
    assert finding["severity"] == "warning"
    assert finding["page"] is None
    assert finding["evidence"] == "cycles=1"


def test_rolemap_cycles_never_leak_into_the_generic_truncation_finding():
    findings = _findings(
        truncation={"roleMapCycles": 3, "nodes": 1},
        roleMap={"LoopA": "LoopB", "LoopB": "LoopA"},
    )
    by_title = _by_title(findings)

    assert set(by_title) == {"RoleMap cycle", "Structure tree truncated"}
    assert by_title["RoleMap cycle"]["evidence"] == "cycles=3"
    assert "roleMapCycles" not in by_title["Structure tree truncated"]["evidence"]
    assert by_title["Structure tree truncated"]["evidence"] == "nodes=1 (limit 5000)"


# --- alternatives and headings ---------------------------------------------


def test_figure_and_formula_without_alt_are_warnings():
    structure = [
        _node(
            "Document",
            "0",
            children=[
                _node("Figure", "0/0", page=3),
                _node("Figure", "0/1", page=4, alt="A chart"),
                _node("Formula", "0/2", page=5),
            ],
        )
    ]

    findings = _by_title(_findings(structure))

    figure = findings["Figure has no alternative text"]
    assert figure["severity"] == "warning"
    assert figure["page"] == 3
    assert figure["evidence"] == "nodes=0/0 (Figure, page 3)"
    formula = findings["Formula has no alternative text"]
    assert formula["severity"] == "warning"
    assert formula["page"] == 5


def test_link_without_any_description_is_a_warning():
    structure = [
        _node(
            "Document",
            "0",
            children=[
                _node("Link", "0/0", page=2),
                _node("Link", "0/1", page=2, actualText="open"),
                _node("Link", "0/2", page=2, title="site"),
                _node("Link", "0/3", page=2, alt="destination"),
            ],
        )
    ]

    findings = _findings(structure)

    assert _titles(findings) == ["Link has no alternate description"]
    finding = findings[0]
    assert finding["severity"] == "warning"
    assert finding["page"] == 2
    assert finding["evidence"] == "nodes=0/0 (Link, page 2)"


def test_heading_gaps_are_reported_once_with_the_first_gap_page():
    structure = [
        _node(
            "Document",
            "0",
            children=[
                _node("H1", "0/0", page=1),
                _node("H3", "0/1", page=2),
                _node("H2", "0/2", page=3),
                _node("H5", "0/3", page=4),
            ],
        )
    ]

    findings = _findings(structure)

    assert _titles(findings) == ["Heading levels are skipped"]
    finding = findings[0]
    assert finding["severity"] == "warning"
    assert finding["page"] == 2
    assert "H1 -> H3 at 0/1 (H3, page 2)" in finding["evidence"]
    assert "H2 -> H5 at 0/3 (H5, page 4)" in finding["evidence"]
    assert "2 gaps" in finding["detail"]


def test_consecutive_headings_and_a_document_starting_at_h2_are_not_flagged():
    structure = [
        _node(
            "Document",
            "0",
            children=[
                _node("H1", "0/0"),
                _node("H2", "0/1"),
                _node("H2", "0/2"),
                _node("H3", "0/3"),
            ],
        )
    ]
    assert _findings(structure) == []
    # A first heading below H1 is not reported: H1 may live outside this tree.
    assert _findings([_node("H2", "0")]) == []


# --- lists and tables -------------------------------------------------------


def test_list_and_table_structure_is_checked():
    structure = [
        _node(
            "Document",
            "0",
            children=[
                _node("L", "0/0", page=1, children=[_node("P", "0/0/0")]),
                _node("LI", "0/1", page=2),
                _node("Table", "0/2", page=3, children=[_node("TD", "0/2/0")]),
                _node(
                    "Table",
                    "0/3",
                    page=4,
                    children=[
                        _node(
                            "TR",
                            "0/3/0",
                            page=4,
                            children=[
                                _node(
                                    "TH",
                                    "0/3/0/0",
                                    page=4,
                                    attributes={"Scope": "Column"},
                                ),
                                _node("TH", "0/3/0/1", page=4),
                            ],
                        )
                    ],
                ),
            ],
        )
    ]

    findings = _by_title(_findings(structure))

    assert list(findings) == [
        "List has no list items",
        "List item has no LBody",
        "Table has no rows",
        "Table header cell has no scope",
    ]
    assert findings["List has no list items"]["severity"] == "warning"
    assert findings["List has no list items"]["page"] == 1
    assert findings["List item has no LBody"]["severity"] == "info"
    assert findings["List item has no LBody"]["page"] == 2
    assert findings["Table has no rows"]["severity"] == "warning"
    assert findings["Table has no rows"]["page"] == 3
    assert findings["Table header cell has no scope"]["severity"] == "info"
    assert findings["Table header cell has no scope"]["page"] == 4
    assert "0/3/0/1" in findings["Table header cell has no scope"]["evidence"]


def test_table_rows_wrapped_in_thead_count_as_rows():
    structure = [
        _node(
            "Document",
            "0",
            children=[
                _node(
                    "Table",
                    "0/0",
                    children=[
                        _node(
                            "THead",
                            "0/0/0",
                            children=[
                                _node(
                                    "TR",
                                    "0/0/0/0",
                                    children=[_node("TD", "0/0/0/0/0")],
                                )
                            ],
                        )
                    ],
                )
            ],
        )
    ]

    assert _findings(structure) == []


# --- truncation -------------------------------------------------------------


def test_truncation_counters_become_one_warning():
    truncation = {
        "nodes": 1,
        "depth": 1,
        "children": 2,
        "attributes": 1,
        "scanned": 1,
        "cycles": 1,
        "roleMap": 4,
        "parentTree": 1,
    }

    findings = _findings(truncation=truncation)
    finding = _by_title(findings)["Structure tree truncated"]

    assert finding["severity"] == "warning"
    assert finding["page"] is None
    for part in (
        "nodes=1 (limit 5000)",
        "depth=1 (limit 32)",
        "children=2 (limit 200)",
        "attributes=1 (limit 20)",
        "scanned=1 (limit 5000)",
        "cycles=1",
        "roleMap=4 (limit 100)",
        "parentTree=1 (limit 10000)",
    ):
        assert part in finding["evidence"]


def test_list_only_truncation_uses_list_wording():
    finding = _by_title(_findings(truncation={"roleMap": 3}))[
        "Structure tree truncated"
    ]

    assert finding["evidence"] == "roleMap=3 (limit 100)"
    assert finding["detail"].startswith("The RoleMap or ParentTree listing")


def test_skipped_entries_become_a_warning_with_pluralization():
    findings = _findings(truncation={"skipped": 3})
    finding = _by_title(findings)["Accessibility parse skipped 3 elements"]

    assert finding["severity"] == "warning"
    assert finding["page"] is None
    assert finding["evidence"] == "skipped=3"

    single = _findings(truncation={"skipped": 1})
    assert _titles(single) == ["Accessibility parse skipped 1 element"]


def test_document_skipped_counter_is_used_when_truncation_is_absent():
    findings = _findings(skipped=2)

    assert _titles(findings) == ["Accessibility parse skipped 2 elements"]


def test_clean_document_has_no_findings():
    assert _findings() == []


# --- contract ---------------------------------------------------------------


def test_findings_follow_the_audit_contract_and_are_sorted():
    structure = [
        _node(
            "Document",
            "0",
            children=[_node("Figure", "0/0", page=1), _node("Figure", "0/1")],
        )
    ]

    findings = _findings(structure, truncation={"nodes": 1, "skipped": 2})

    assert findings == audit.sort_findings(findings)
    assert len(findings) == len({audit._sort_key(finding) for finding in findings})
    for finding in findings:
        assert set(finding) == set(FINDING_KEYS) | {FINGERPRINT_KEY}
        assert finding["category"] in AUDIT_CATEGORIES
        assert finding["category"] == "structure"
        assert finding["severity"] in {"error", "warning", "info"}
        assert finding["page"] is None or isinstance(finding["page"], int)


# --- Audit integration ------------------------------------------------------


def test_audit_document_merges_structure_findings_once():
    result = _audit_document(SAMPLES / "accessibility-broken.pdf")

    assert set(result) == {"tool", "document", "findings"}
    assert set(result["document"]) == {
        "pages",
        "version",
        "encrypted",
        "title",
        "author",
        "producer",
        "language",
        "tagged",
    }
    titles = _titles(result["findings"])
    assert titles == BROKEN_TITLES
    assert "PDF is not tagged" not in titles
    assert result["document"]["tagged"] is True


def test_audit_file_keeps_the_report_schema_and_summary():
    report = audit_file(SAMPLES / "accessibility-broken.pdf")

    assert set(report) == {"schemaVersion", "tool", "document", "summary", "findings"}
    assert report["schemaVersion"] == 1
    assert report["summary"] == audit.summarize_findings(report["findings"])
    assert report["summary"]["total"] == len(BROKEN_TITLES)
    assert report["summary"]["warnings"] == len(BROKEN_TITLES)
    assert report["findings"] == audit.sort_findings(report["findings"])
    assert _titles(report["findings"]) == BROKEN_TITLES


def test_audit_preserves_existing_findings_and_one_not_tagged_hint(tmp_path):
    path = _write_untagged_pdf(tmp_path / "untagged.pdf")

    report = audit_file(path)
    titles = _titles(report["findings"])

    assert titles.count("PDF is not tagged") == 1
    for title in (
        "Missing document title",
        "Missing document author",
        "Missing document language",
    ):
        assert title in titles
    assert report["document"]["tagged"] is False


def test_audit_softens_not_tagged_for_an_unreadable_struct_tree_root(tmp_path):
    path = _write_pdf_objects(
        tmp_path / "unreadable-root.pdf",
        [
            b"<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 9 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R >>",
            b"<< /Length 0 >>\nstream\n\nendstream",
        ],
    )

    result = _audit_document(path)
    titles = _titles(result["findings"])

    assert titles.count("PDF is not tagged") == 1
    assert result["document"]["tagged"] is False
    finding = _by_title(result["findings"])["PDF is not tagged"]
    assert finding["detail"].startswith("No readable /StructTreeRoot")


def test_valid_sample_has_no_findings_in_the_audit():
    report = audit_file(SAMPLES / "accessibility-valid.pdf")

    assert report["findings"] == []
    assert report["summary"] == {"total": 0, "errors": 0, "warnings": 0, "info": 0}


# --- report shape and determinism ------------------------------------------


def test_accessibility_report_shape_and_determinism():
    path = SAMPLES / "accessibility-broken.pdf"
    first = _report(path)
    second = _report(path)

    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    assert set(first) == {
        "schemaVersion",
        "tool",
        "document",
        "structure",
        "findings",
        "summary",
    }
    assert first["schemaVersion"] == 1
    assert first["tool"] == audit.tool()
    assert set(first["document"]) == DOCUMENT_KEYS
    assert first["document"]["truncated"] is False
    assert first["document"]["skipped"] == 0
    assert first["structure"][0]["role"] == "Document"
    assert _titles(first["findings"]) == BROKEN_TITLES
    assert first["summary"] == audit.summarize_findings(first["findings"])

    payload = json.dumps(first)
    assert str(SAMPLES) not in payload
    assert str(path) not in payload
    assert "creationdate" not in payload.lower()
    assert "moddate" not in payload.lower()
    assert not re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", payload)


# --- committed samples ------------------------------------------------------


def test_valid_sample_structure_and_findings():
    report = _report(SAMPLES / "accessibility-valid.pdf")

    assert report["document"]["tagged"] is True
    assert report["document"]["hasParentTree"] is True
    assert report["document"]["language"] == "en-US"
    assert report["findings"] == []

    root = report["structure"][0]
    assert root["role"] == "Document"
    assert [child["role"] for child in root["children"]] == [
        "H1",
        "P",
        "Figure",
        "Table",
    ]
    assert root["children"][2]["alt"]
    row = root["children"][3]["children"][0]
    assert row["role"] == "TR"
    assert [cell["role"] for cell in row["children"]] == ["TH", "TD"]
    assert row["children"][0]["attributes"].get("Scope") == "Column"


def test_broken_sample_has_the_expected_structure_and_findings():
    report = _report(SAMPLES / "accessibility-broken.pdf")

    assert report["document"]["tagged"] is True
    assert report["document"]["hasStructTreeRoot"] is True
    assert report["document"]["hasParentTree"] is False
    assert _titles(report["findings"]) == BROKEN_TITLES

    root = report["structure"][0]
    assert root["role"] == "Document"
    assert [child["role"] for child in root["children"]] == [
        "H1",
        "H3",
        "Figure",
        "L",
        "Table",
    ]
    assert root["children"][2]["alt"] is None
    assert root["children"][3]["children"][0]["role"] == "P"
    assert root["children"][4]["children"][0]["role"] == "TD"


def test_samples_open_and_extract_text_in_pdfplumber():
    for name in ("accessibility-valid.pdf", "accessibility-broken.pdf"):
        extractor = PdfExtractor(str(SAMPLES / name))
        try:
            metadata = extractor.get_metadata()
            page = extractor.extract_page(1)
        finally:
            extractor.close()

        assert metadata["pages"] == 1
        assert page["chars"], f"{name} must contain extractable text"
        text = "".join(char["text"] for char in page["chars"])
        assert "Quarterly" in text


def test_sample_generator_is_byte_identical_and_matches_the_committed_files(
    tmp_path,
):
    module = _load_generator()

    valid = module.build_valid_pdf()
    broken = module.build_broken_pdf()
    assert valid == module.build_valid_pdf()
    assert broken == module.build_broken_pdf()

    first = module.write_samples(tmp_path / "first")
    second = module.write_samples(tmp_path / "second")
    assert len(first) == len(second) == 2
    for left, right in zip(first, second):
        assert left.read_bytes() == right.read_bytes()

    assert first[0].read_bytes() == (SAMPLES / module.VALID_NAME).read_bytes()
    assert first[1].read_bytes() == (SAMPLES / module.BROKEN_NAME).read_bytes()
