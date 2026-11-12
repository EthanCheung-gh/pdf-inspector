"""Tagged-PDF structure parser: document facts and the bounded structure forest.

Minimal hand-written PDFs pin the real pdfminer object model (references,
names, MCID/MCR/OBJR entries, page object ids and number trees).  Fake
extractors pin what a real PDF cannot produce on demand: broken references,
structure-tree cycles, very deep trees and every resource cap.
"""

import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

from pdfminer.psparser import PSLiteral

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import accessibility  # noqa: E402
from accessibility import (  # noqa: E402
    FACT_KEYS,
    MAX_NODES,
    MAX_PARENT_TREE,
    TRUNCATION_KEYS,
)
from extractor import PdfExtractor  # noqa: E402

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
NODE_KEYS = {
    "id",
    "kind",
    "role",
    "rawRole",
    "title",
    "alt",
    "actualText",
    "lang",
    "page",
    "mcid",
    "objectNumber",
    "attributes",
    "children",
    "truncated",
}


# --- minimal PDF writer -----------------------------------------------------


def _write_pdf(path: Path, objects: list[bytes], trailer_extra: bytes = b"") -> str:
    """Write a minimal PDF with numbered (1-based) uncompressed objects."""
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref_position = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    trailer = b"trailer\n<< /Size %d /Root 1 0 R" % (len(objects) + 1)
    if trailer_extra:
        trailer += b" " + trailer_extra
    out += trailer + b" >>\nstartxref\n%d\n%%%%EOF\n" % xref_position
    path.write_bytes(bytes(out))
    return str(path)


def _tagged_pdf(
    path: Path,
    root: bytes = b"/K 6 0 R",
    extra_objects: list[bytes] = (),
    catalog_extra: bytes = b"",
    page_attributes: bytes = b"",
    trailer_extra: bytes = b"",
    content: bytes = b"",
) -> str:
    """One-page PDF whose catalog points at object 5 (the StructTreeRoot)."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 5 0 R "
        + catalog_extra
        + b" >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R "
        + page_attributes
        + b" >>",
        b"<< /Length %d >>\nstream\n" % len(content)
        + content
        + b"\nendstream",
        b"<< /Type /StructTreeRoot " + root + b" >>",
    ] + list(extra_objects)
    return _write_pdf(path, objects, trailer_extra)


def _untagged_pdf(path: Path, catalog_extra: bytes = b"") -> str:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R " + catalog_extra + b" >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        b"<< /Length 0 >>\nstream\n\nendstream",
    ]
    return _write_pdf(path, objects)


def _two_page_tagged_pdf(path: Path, extra_objects: list[bytes]) -> str:
    """Two pages whose page objects are objects 3 (page 1) and 5 (page 2)."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        b"<< /Length 0 >>\nstream\n\nendstream",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>",
        b"<< /Length 0 >>\nstream\n\nendstream",
        b"<< /Type /StructTreeRoot /K 8 0 R >>",
    ] + list(extra_objects)
    return _write_pdf(path, objects)


# --- fake extractors --------------------------------------------------------


class _Ref:
    """Minimal pdfminer-style indirect reference."""

    def __init__(self, objid, target):
        self.objid = objid
        self._target = target

    def resolve(self):
        if isinstance(self._target, BaseException):
            raise self._target
        return self._target


class _BrokenRef:
    objid = 999

    def resolve(self):
        raise RuntimeError("broken object reference")


class _ExplodingCatalog(dict):
    def get(self, key, default=None):
        raise RuntimeError("broken catalog entry")


class _FakeDoc:
    def __init__(self, catalog=None, info=None, xrefs=None, encryption=None):
        self.catalog = catalog if catalog is not None else {}
        self.info = list(info or [])
        self._xrefs = xrefs
        self.encryption = encryption

    @property
    def xrefs(self):
        return self._xrefs if self._xrefs is not None else []


class _FakePdf:
    def __init__(self, pages, doc, version="1.7"):
        self.pages = list(pages)
        self.doc = doc
        self.pdf_version = version
        self.metadata = {}

    @property
    def is_encrypted(self):
        return bool(self.doc.encryption)


class _FakeExtractor:
    def __init__(self, catalog=None, pages=None, version="1.7", encryption=None):
        self._pdf = _FakePdf(
            pages if pages is not None else [_fake_page(10)],
            _FakeDoc(catalog, encryption=encryption),
            version,
        )
        self._path = None


def _fake_page(page_id, struct_parents=None, contents=None):
    attrs = {}
    if struct_parents is not None:
        attrs["StructParents"] = struct_parents
    if contents is not None:
        attrs["Contents"] = contents
    return SimpleNamespace(
        page_obj=SimpleNamespace(pageid=page_id, attrs=attrs),
    )


def _name(text):
    return PSLiteral(text)


def _struct(role, kids=None, **extra):
    node = {"Type": _name("StructElem"), "S": _name(role)}
    if kids is not None:
        node["K"] = kids
    node.update(extra)
    return node


# --- helpers ----------------------------------------------------------------


def _collect(path) -> tuple[dict, dict]:
    extractor = PdfExtractor(str(path))
    try:
        return accessibility.collect_accessibility(extractor)
    finally:
        extractor.close()


def _collect_fake(catalog, pages=None, encryption=None) -> tuple[dict, dict]:
    return accessibility.collect_accessibility(
        _FakeExtractor(catalog, pages, encryption=encryption)
    )


def _assert_node_shape(node) -> None:
    assert set(node) == NODE_KEYS
    assert node["kind"] in {"element", "mcid", "object"}
    assert isinstance(node["role"], str)
    assert node["rawRole"] is None or isinstance(node["rawRole"], str)
    for key in ("title", "alt", "actualText", "lang"):
        assert node[key] is None or isinstance(node[key], str)
    assert node["page"] is None or isinstance(node["page"], int)
    assert node["mcid"] is None or isinstance(node["mcid"], int)
    assert node["objectNumber"] is None or isinstance(node["objectNumber"], int)
    assert isinstance(node["attributes"], dict)
    assert len(node["attributes"]) <= 20
    assert isinstance(node["children"], list)
    assert isinstance(node["truncated"], bool)
    for child in node["children"]:
        _assert_node_shape(child)


def _count_nodes(nodes) -> int:
    return sum(1 + _count_nodes(node["children"]) for node in nodes)


# --- document contract and minimal tree ------------------------------------


def test_collect_returns_document_and_structure_blocks(tmp_path):
    path = _tagged_pdf(
        tmp_path / "minimal.pdf",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R] >>",
            b"<< /Type /StructElem /S /P /Pg 3 0 R /K 0 >>",
        ],
        catalog_extra=b"/Lang (en-US)",
    )

    resources, truncation = _collect(path)

    assert set(resources) == {"document", "structure"}
    assert set(resources["document"]) == DOCUMENT_KEYS
    document = resources["document"]
    assert document["pages"] == 1
    assert document["version"] == "1.4"
    assert document["encrypted"] is False
    assert document["tagged"] is True
    assert document["hasStructTreeRoot"] is True
    assert document["hasParentTree"] is False
    assert document["language"] == "en-US"
    assert document["title"] is None
    assert document["roleMap"] == {}
    assert document["truncated"] is False
    assert document["skipped"] == 0
    assert truncation == {}
    json.dumps(resources)

    root = resources["structure"][0]
    assert root["id"] == "0"
    assert root["kind"] == "element"
    assert root["role"] == "Document"
    assert root["rawRole"] == "Document"
    child = root["children"][0]
    assert (child["id"], child["role"], child["rawRole"], child["page"]) == (
        "0/0",
        "P",
        "P",
        1,
    )
    content = child["children"][0]
    assert (content["id"], content["kind"], content["role"]) == (
        "0/0/0",
        "mcid",
        "MCID",
    )
    assert content["mcid"] == 0
    assert content["rawRole"] is None
    assert content["page"] == 1
    assert content["children"] == []
    _assert_node_shape(root)


def test_document_title_comes_from_the_info_dictionary(tmp_path):
    path = _tagged_pdf(
        tmp_path / "title.pdf",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R] >>",
            b"<< /Type /StructElem /S /P /K 0 >>",
            b"<< /Title (Tagged document) >>",
        ],
        trailer_extra=b"/Info 8 0 R",
    )

    document = _collect(path)[0]["document"]

    assert document["title"] == "Tagged document"


# --- nested roles and attributes -------------------------------------------


def test_version_uses_catalog_before_the_header(tmp_path):
    path = _tagged_pdf(
        tmp_path / "version.pdf",
        catalog_extra=b"/Version /1.6",
        extra_objects=[b"<< /Type /StructElem /S /Document /K [] >>"],
    )

    assert _collect(path)[0]["document"]["version"] == "1.6"


def test_nested_sect_heading_figure_table_and_cells(tmp_path):
    path = _tagged_pdf(
        tmp_path / "nested.pdf",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R] >>",
            b"<< /Type /StructElem /S /Sect /K [8 0 R 9 0 R 10 0 R 11 0 R] >>",
            b"<< /Type /StructElem /S /H1 /Pg 3 0 R /K 0 >>",
            b"<< /Type /StructElem /S /Figure /Pg 3 0 R /K 1 "
            b"/Alt (A figure) >>",
            b"<< /Type /StructElem /S /Table /Pg 3 0 R /K [12 0 R] >>",
            b"<< /Type /StructElem /S /P /Pg 3 0 R /K 2 /T (Para) "
            b"/ActualText (actual text) /Lang (de-DE) >>",
            b"<< /Type /StructElem /S /TR /K [13 0 R 14 0 R] >>",
            b"<< /Type /StructElem /S /TH /K 3 /A << /Scope /Column "
            b"/RowSpan 2 >> >>",
            b"<< /Type /StructElem /S /TD /K 4 >>",
        ],
    )

    structure = _collect(path)[0]["structure"]

    root = structure[0]
    sect = root["children"][0]
    assert sect["role"] == "Sect"
    assert sect["id"] == "0/0"
    assert [child["role"] for child in sect["children"]] == [
        "H1",
        "Figure",
        "Table",
        "P",
    ]

    heading, figure, table, paragraph = sect["children"]
    assert heading["children"][0]["mcid"] == 0
    assert figure["alt"] == "A figure"
    assert figure["children"][0]["mcid"] == 1
    assert paragraph["title"] == "Para"
    assert paragraph["actualText"] == "actual text"
    assert paragraph["lang"] == "de-DE"

    row = table["children"][0]
    assert row["role"] == "TR"
    assert (row["id"], row["page"]) == ("0/0/2/0", 1)
    header, cell = row["children"]
    assert header["role"] == "TH"
    assert (header["id"], header["page"]) == ("0/0/2/0/0", 1)
    assert header["attributes"] == {"Scope": "Column", "RowSpan": "2"}
    assert cell["role"] == "TD"
    assert cell["children"][0]["mcid"] == 4
    _assert_node_shape(root)


# --- RoleMap ----------------------------------------------------------------


def test_role_map_resolves_custom_roles_cycles_and_unknown_roles(tmp_path):
    path = _tagged_pdf(
        tmp_path / "roles.pdf",
        root=b"/RoleMap << /Alias /Custom /Custom /H1 /LoopA /LoopB "
        b"/LoopB /LoopA /Broken 99 0 R >> /K 6 0 R",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R 8 0 R 9 0 R] >>",
            b"<< /Type /StructElem /S /Alias /K 0 >>",
            b"<< /Type /StructElem /S /LoopA /K 1 >>",
            b"<< /Type /StructElem /S /UnknownRole /K 2 >>",
        ],
    )

    resources, truncation = _collect(path)

    assert resources["document"]["roleMap"] == {
        "Alias": "H1",
        "Custom": "H1",
        "LoopA": "LoopA",
        "LoopB": "LoopB",
    }
    assert resources["document"]["skipped"] == 1
    assert truncation["roleMapCycles"] == 1
    assert "roleMapCycles" in FACT_KEYS
    assert "roleMapCycles" not in TRUNCATION_KEYS

    children = resources["structure"][0]["children"]
    assert [child["role"] for child in children] == [
        "H1",
        "LoopA",
        "UnknownRole",
    ]
    assert [child["rawRole"] for child in children] == [
        "Alias",
        "LoopA",
        "UnknownRole",
    ]


def test_role_map_counts_distinct_cycles_once_per_chain():
    role_map = {
        "LoopA": _name("LoopB"),
        "LoopB": _name("LoopA"),
        "LoopC": _name("LoopD"),
        "LoopD": _name("LoopC"),
        "Identity": _name("Identity"),
        "Alias": _name("Identity"),
    }
    root = _struct(
        "Document",
        [
            _Ref(11, _struct("LoopA")),
            _Ref(12, _struct("LoopA")),
            _Ref(13, _struct("LoopB")),
            _Ref(14, _struct("LoopC")),
            _Ref(15, _struct("LoopD")),
            _Ref(16, _struct("Identity")),
            _Ref(17, _struct("Alias")),
        ],
    )
    catalog = {
        "StructTreeRoot": {"RoleMap": role_map, "K": [_Ref(1, root)]}
    }

    resources, truncation = _collect_fake(catalog)

    assert truncation["roleMapCycles"] == 2
    assert resources["document"]["truncated"] is False
    role_map_out = resources["document"]["roleMap"]
    assert role_map_out["LoopA"] == "LoopA"
    assert role_map_out["LoopB"] == "LoopB"
    assert role_map_out["Identity"] == "Identity"
    assert role_map_out["Alias"] == "Identity"
    roles = [child["role"] for child in resources["structure"][0]["children"]]
    assert roles == [
        "LoopA",
        "LoopA",
        "LoopB",
        "LoopC",
        "LoopD",
        "Identity",
        "Identity",
    ]


def test_identity_role_map_entry_is_not_a_cycle():
    catalog = {
        "StructTreeRoot": {
            "RoleMap": {"P": _name("P")},
            "K": [_Ref(1, _struct("P"))],
        }
    }

    resources, truncation = _collect_fake(catalog)

    assert resources["document"]["roleMap"] == {"P": "P"}
    assert resources["structure"][0]["role"] == "P"
    assert "roleMapCycles" not in truncation


def test_role_map_is_capped_and_sorted():
    role_map = {f"Custom{i:03d}": _name("H1") for i in range(120)}
    catalog = {
        "StructTreeRoot": {
            "RoleMap": role_map,
            "K": [_struct("Document")],
        }
    }

    resources, truncation = _collect_fake(catalog)

    resolved = resources["document"]["roleMap"]
    assert len(resolved) == accessibility.MAX_ROLE_MAP
    assert list(resolved) == sorted(resolved)
    assert resolved["Custom000"] == "H1"
    assert "Custom119" not in resolved
    assert truncation["roleMap"] == 20


# --- ParentTree -------------------------------------------------------------


def test_parent_tree_nums_and_page_struct_parents(tmp_path):
    path = _tagged_pdf(
        tmp_path / "parent-nums.pdf",
        root=b"/K 6 0 R /ParentTree 8 0 R",
        page_attributes=b"/StructParents 0",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R] >>",
            b"<< /Type /StructElem /S /P /K 0 >>",
            b"<< /Nums [0 [6 0 R] 1 [7 0 R]] >>",
        ],
    )

    resources, truncation = _collect(path)

    assert resources["document"]["hasParentTree"] is True
    assert truncation["parentTreeEntries"] == 2
    assert truncation["pagesWithStructParents"] == 1


def test_parent_tree_kids_are_walked(tmp_path):
    path = _tagged_pdf(
        tmp_path / "parent-kids.pdf",
        root=b"/K 6 0 R /ParentTree 8 0 R",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R] >>",
            b"<< /Type /StructElem /S /P /K 0 >>",
            b"<< /Kids [9 0 R] >>",
            b"<< /Limits [0 1] /Nums [0 [6 0 R] 1 [7 0 R]] >>",
        ],
    )

    resources, truncation = _collect(path)

    assert resources["document"]["hasParentTree"] is True
    assert truncation["parentTreeEntries"] == 2
    # The page's only content stream is /Length 0, so it is blank and is not
    # named; the total fact is still present because the check ran.
    assert "pagesMissingStructParents" not in truncation
    assert truncation["pagesMissingStructParentsTotal"] == 0


def test_parent_tree_entry_cap_stops_reading():
    nums = []
    for index in range(MAX_PARENT_TREE + 1):
        nums.extend([index, []])
    catalog = {
        "StructTreeRoot": {
            "ParentTree": {"Nums": nums},
            "K": [],
        }
    }

    resources, truncation = _collect_fake(catalog)

    assert resources["document"]["hasParentTree"] is True
    assert truncation["parentTreeEntries"] == MAX_PARENT_TREE
    assert truncation["parentTree"] == 1


def test_parent_tree_depth_and_cycles_are_bounded():
    deep = {"Nums": []}
    for _index in range(accessibility.MAX_PARENT_TREE_DEPTH + 4):
        deep = {"Kids": [deep]}
    deep_catalog = {"StructTreeRoot": {"ParentTree": deep, "K": []}}

    _resources, deep_truncation = _collect_fake(deep_catalog)
    assert deep_truncation["parentTree"] >= 1

    cyclic = {"Nums": []}
    cyclic_ref = _Ref(50, cyclic)
    cyclic["Kids"] = [cyclic_ref]
    cyclic_catalog = {"StructTreeRoot": {"ParentTree": cyclic, "K": []}}

    _resources, cyclic_truncation = _collect_fake(cyclic_catalog)
    assert cyclic_truncation["parentTree"] >= 1


def test_pages_missing_struct_parents_names_pages(tmp_path):
    path = _tagged_pdf(
        tmp_path / "missing-page-parent.pdf",
        root=b"/K 6 0 R /ParentTree 8 0 R",
        content=b"BT ET",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R] >>",
            b"<< /Type /StructElem /S /P /K 0 >>",
            b"<< /Nums [] >>",
        ],
    )

    resources, truncation = _collect(path)

    assert resources["document"]["hasParentTree"] is True
    assert truncation["pagesMissingStructParents"] == [1]
    assert truncation["pagesMissingStructParentsTotal"] == 1
    assert "pagesMissingStructParents" in FACT_KEYS
    assert "pagesMissingStructParentsTotal" in FACT_KEYS


def test_pages_missing_struct_parents_is_capped_and_skips_parented_pages():
    pages = [
        _fake_page(10 + index, contents=object()) for index in range(12)
    ]
    pages[1] = _fake_page(11, struct_parents=0, contents=object())
    catalog = {
        "StructTreeRoot": {"ParentTree": {"Nums": []}, "K": []}
    }

    resources, truncation = _collect_fake(catalog, pages=pages)

    assert resources["document"]["hasParentTree"] is True
    missing = truncation["pagesMissingStructParents"]
    assert missing == [1, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    assert len(missing) == accessibility.MAX_MISSING_STRUCT_PARENTS
    assert truncation["pagesMissingStructParentsTotal"] == 11


def test_pages_missing_struct_parents_total_counts_pages_beyond_the_cap():
    pages = [_fake_page(10 + index, contents=object()) for index in range(25)]
    catalog = {
        "StructTreeRoot": {"ParentTree": {"Nums": []}, "K": []}
    }

    _resources, truncation = _collect_fake(catalog, pages=pages)

    listed = truncation["pagesMissingStructParents"]
    assert listed == list(range(1, accessibility.MAX_MISSING_STRUCT_PARENTS + 1))
    assert truncation["pagesMissingStructParentsTotal"] == 25


def test_blank_length_zero_content_pages_are_not_named():
    pages = [
        _fake_page(10, contents=SimpleNamespace(attrs={"Length": 0})),
        _fake_page(11, contents=SimpleNamespace(attrs={"Length": 5})),
    ]
    catalog = {
        "StructTreeRoot": {"ParentTree": {"Nums": []}, "K": []}
    }

    _resources, truncation = _collect_fake(catalog, pages=pages)

    assert truncation["pagesMissingStructParents"] == [2]
    assert truncation["pagesMissingStructParentsTotal"] == 1


# --- /K entry kinds ---------------------------------------------------------


def test_k_accepts_integer_mcr_objr_and_mixed_arrays(tmp_path):
    path = _tagged_pdf(
        tmp_path / "mixed.pdf",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R 0 8 0 R 9 0 R] >>",
            b"<< /Type /StructElem /S /P /Pg 3 0 R /K 0 >>",
            b"<< /Type /MCR /Pg 3 0 R /MCID 4 >>",
            b"<< /Type /OBJR /Pg 3 0 R /Obj 99 0 R >>",
        ],
    )

    structure = _collect(path)[0]["structure"]

    children = structure[0]["children"]
    assert [child["id"] for child in children] == ["0/0", "0/1", "0/2", "0/3"]
    assert [child["kind"] for child in children] == [
        "element",
        "mcid",
        "mcid",
        "object",
    ]
    assert [child["role"] for child in children] == [
        "P",
        "MCID",
        "MCID",
        "OBJR",
    ]

    element, integer, mcr, objr = children
    assert element["children"][0]["mcid"] == 0
    assert (integer["mcid"], integer["page"]) == (0, None)
    assert (mcr["mcid"], mcr["page"]) == (4, 1)
    assert (objr["objectNumber"], objr["page"]) == (99, 1)
    assert objr["mcid"] is None
    _assert_node_shape(structure[0])


def test_k_can_be_an_indirect_array(tmp_path):
    path = _tagged_pdf(
        tmp_path / "indirect-array.pdf",
        root=b"/K 6 0 R",
        extra_objects=[
            b"[7 0 R 8 0 R]",
            b"<< /Type /StructElem /S /P /K 0 >>",
            b"<< /Type /StructElem /S /P /K 1 >>",
        ],
    )

    structure = _collect(path)[0]["structure"]

    assert [node["role"] for node in structure] == ["P", "P"]
    assert [node["id"] for node in structure] == ["0", "1"]


def test_k_can_be_a_single_integer_root(tmp_path):
    path = _tagged_pdf(tmp_path / "integer-root.pdf", root=b"/K 7")

    structure = _collect(path)[0]["structure"]

    assert len(structure) == 1
    assert structure[0]["kind"] == "mcid"
    assert structure[0]["role"] == "MCID"
    assert structure[0]["mcid"] == 7
    assert structure[0]["id"] == "0"


# --- page mapping -----------------------------------------------------------


def test_pg_references_map_to_page_numbers_with_integer_fallback(tmp_path):
    path = _two_page_tagged_pdf(
        tmp_path / "pages.pdf",
        [
            b"<< /Type /StructElem /S /Document /K [9 0 R 10 0 R 11 0 R 12 0 R] >>",
            b"<< /Type /StructElem /S /P /Pg 3 0 R /K 0 >>",
            b"<< /Type /StructElem /S /P /Pg 5 0 R /K 0 >>",
            b"<< /Type /StructElem /S /P /Pg 2 /K 0 >>",
            b"<< /Type /StructElem /S /P /Pg 9 0 R /K 0 >>",
        ],
    )

    structure = _collect(path)[0]["structure"]

    pages = [child["page"] for child in structure[0]["children"]]
    assert pages == [1, 2, 2, None]


# --- malformed input, cycles and caps --------------------------------------


def test_malformed_entries_are_skipped_and_broken_roots_degrade():
    valid = _struct("P", [0])
    catalog = {
        "StructTreeRoot": _Ref(
            5,
            {
                "K": [None, b"not-a-node", _BrokenRef(), _Ref(7, valid)],
            },
        )
    }

    resources, _truncation = _collect_fake(catalog)

    assert resources["document"]["tagged"] is True
    assert resources["document"]["hasStructTreeRoot"] is True
    assert resources["document"]["skipped"] == 3
    assert [node["role"] for node in resources["structure"]] == ["P"]

    broken_root_catalog = {"StructTreeRoot": _BrokenRef()}
    broken, _ = _collect_fake(broken_root_catalog)
    assert broken["document"]["hasStructTreeRoot"] is True
    assert broken["document"]["skipped"] == 1
    assert broken["structure"] == []

    broken_parent_catalog = {
        "StructTreeRoot": {"ParentTree": _BrokenRef(), "K": []}
    }
    broken_parent, _ = _collect_fake(broken_parent_catalog)
    assert broken_parent["document"]["hasStructTreeRoot"] is True
    assert broken_parent["document"]["hasParentTree"] is True
    assert broken_parent["document"]["skipped"] == 1
    assert broken_parent["structure"] == []

    exploding, truncation = _collect_fake(_ExplodingCatalog())
    document = exploding["document"]
    assert set(document) == DOCUMENT_KEYS
    assert document["pages"] == 1
    assert document["version"] == "1.7"
    assert document["tagged"] is False
    assert document["hasStructTreeRoot"] is False
    assert document["hasParentTree"] is False
    assert document["language"] is None
    assert document["title"] is None
    assert document["roleMap"] == {}
    assert exploding["structure"] == []
    assert truncation == {}


def test_resolve_hop_cap_skips_overlong_reference_chain():
    target = _struct("P", [0])
    for index in range(accessibility.MAX_RESOLVE + 2):
        target = _Ref(300 + index, target)
    catalog = {"StructTreeRoot": {"K": [target]}}

    resources, truncation = _collect_fake(catalog)

    assert resources["structure"] == []
    assert resources["document"]["skipped"] == 1
    assert truncation["skipped"] == 1


def test_element_without_role_is_emitted_with_empty_role():
    element = {"Type": _name("StructElem"), "K": [0]}
    catalog = {"StructTreeRoot": {"K": [element]}}

    resources, _truncation = _collect_fake(catalog)

    node = resources["structure"][0]
    assert node["role"] == ""
    assert node["rawRole"] is None
    assert node["children"][0]["kind"] == "mcid"
    assert resources["document"]["skipped"] == 0


def test_missing_structure_reference_is_skipped(tmp_path):
    path = _tagged_pdf(tmp_path / "missing-ref.pdf", root=b"/K 99 0 R")

    resources, truncation = _collect(path)

    assert resources["document"]["hasStructTreeRoot"] is True
    assert resources["document"]["hasParentTree"] is False
    assert resources["document"]["skipped"] == 1
    assert resources["structure"] == []
    assert truncation["skipped"] == 1


def test_structure_tree_cycles_are_cut_and_marked():
    parent = _struct("Document")
    child = _struct("P")
    parent_ref = _Ref(1, parent)
    child_ref = _Ref(2, child)
    parent["K"] = [child_ref]
    child["K"] = [parent_ref]

    resources, truncation = _collect_fake({"StructTreeRoot": {"K": [parent_ref]}})

    root = resources["structure"][0]
    assert root["role"] == "Document"
    assert root["children"][0]["role"] == "P"
    assert root["children"][0]["children"] == []
    assert root["children"][0]["truncated"] is True
    assert truncation["cycles"] == 1
    assert resources["document"]["truncated"] is True
    assert resources["document"]["skipped"] == 0


def test_deep_tree_is_cut_at_the_depth_limit():
    node = _struct("P")
    for index in range(80):
        node = _struct("Sect", [_Ref(index + 1, node)])

    resources, truncation = _collect_fake({"StructTreeRoot": {"K": [_Ref(0, node)]}})

    assert _count_nodes(resources["structure"]) == accessibility.MAX_DEPTH + 1
    assert resources["document"]["truncated"] is True
    assert truncation["depth"] == 1

    deepest = resources["structure"][0]
    depth = 0
    while deepest["children"]:
        deepest = deepest["children"][0]
        depth += 1
    assert depth == accessibility.MAX_DEPTH
    assert deepest["truncated"] is True


def test_node_budget_stops_expansion():
    children = [
        _Ref(
            100 + index,
            _struct("P", [index * 1000 + offset for offset in range(200)]),
        )
        for index in range(40)
    ]
    root = _struct("Document", children)

    resources, truncation = _collect_fake({"StructTreeRoot": {"K": [_Ref(1, root)]}})

    assert _count_nodes(resources["structure"]) == MAX_NODES
    assert resources["document"]["truncated"] is True
    assert truncation["nodes"] == 1
    _assert_node_shape(resources["structure"][0])


def test_scan_budget_stops_malformed_entries():
    children = [
        _Ref(200 + index, _struct("P", [None] * accessibility.MAX_CHILDREN))
        for index in range(200)
    ]
    root = _struct("Document", children)

    resources, truncation = _collect_fake({"StructTreeRoot": {"K": [_Ref(1, root)]}})

    assert truncation["scanned"] == 1
    assert "nodes" not in truncation
    assert resources["document"]["truncated"] is True
    assert _count_nodes(resources["structure"]) < MAX_NODES


def test_child_cap_per_node_is_marked():
    root = _struct("Document", list(range(accessibility.MAX_CHILDREN + 1)))

    resources, truncation = _collect_fake({"StructTreeRoot": {"K": [_Ref(1, root)]}})

    node = resources["structure"][0]
    assert len(node["children"]) == accessibility.MAX_CHILDREN
    assert node["truncated"] is True
    assert truncation["children"] == 1
    assert resources["document"]["truncated"] is True


def test_attribute_cap_and_value_rendering():
    attributes = {
        "BBox": [0, 0, 100, 200],
        "Placement": _name("Block"),
        "Scope": _name("Row"),
        "RowSpan": 2,
        "ColSpan": None,
        "Headers": [b"A", b"B"],
        "Nested": {"x": 1},
    }
    for index in range(20):
        attributes[f"Custom{index}"] = index
    root = _struct("TH", [0], A=attributes)

    resources, truncation = _collect_fake({"StructTreeRoot": {"K": [_Ref(1, root)]}})

    node = resources["structure"][0]
    values = node["attributes"]
    assert len(values) == accessibility.MAX_ATTRIBUTES
    assert values["BBox"] == "0, 0, 100, 200"
    assert values["Placement"] == "Block"
    assert values["Scope"] == "Row"
    assert values["RowSpan"] == "2"
    assert values["ColSpan"] is None
    assert values["Headers"] == "A, B"
    assert values["Nested"] is None
    assert truncation["attributes"] == 1
    # Attribute truncation does not truncate the structure tree itself.
    assert resources["document"]["truncated"] is False


def test_attribute_array_cut_is_reported():
    attributes = [{"Scope": _name("Row")} for _index in range(30)]
    root = _struct("TH", [0], A=attributes)

    resources, truncation = _collect_fake({"StructTreeRoot": {"K": [_Ref(1, root)]}})

    node = resources["structure"][0]
    assert node["attributes"] == {"Scope": "Row"}
    assert truncation["attributes"] == 1
    assert resources["document"]["truncated"] is False


def test_text_fields_and_attribute_values_are_bounded():
    long_text = "x" * (accessibility.MAX_TEXT + 20)
    root = _struct(
        "P",
        [0],
        T=long_text,
        Alt=long_text,
        ActualText=long_text,
        Lang=long_text,
        A={"Key": long_text},
    )

    resources, _truncation = _collect_fake({"StructTreeRoot": {"K": [_Ref(1, root)]}})

    node = resources["structure"][0]
    for key in ("title", "alt", "actualText", "lang"):
        assert len(node[key]) == accessibility.MAX_TEXT
    assert len(node["attributes"]["Key"]) == accessibility.MAX_TEXT


# --- tagging flags, determinism and safety ---------------------------------


def test_untagged_and_markinfo_documents(tmp_path):
    untagged = _collect(_untagged_pdf(tmp_path / "untagged.pdf"))
    assert untagged[0]["document"]["tagged"] is False
    assert untagged[0]["document"]["hasStructTreeRoot"] is False
    assert untagged[0]["document"]["hasParentTree"] is False
    assert untagged[0]["structure"] == []

    marked = _collect(
        _untagged_pdf(
            tmp_path / "marked.pdf",
            catalog_extra=b"/MarkInfo << /Marked true >>",
        )
    )
    assert marked[0]["document"]["tagged"] is True
    assert marked[0]["document"]["hasStructTreeRoot"] is False


def test_encrypted_document_sets_flag():
    resources, _truncation = _collect_fake(
        {},
        encryption=("id", {"Filter": _name("Standard")}),
    )

    assert resources["document"]["encrypted"] is True
    assert resources["document"]["tagged"] is False
    assert resources["structure"] == []


def test_struct_tree_without_parent_tree_still_parses(tmp_path):
    path = _tagged_pdf(
        tmp_path / "no-parent.pdf",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R] >>",
            b"<< /Type /StructElem /S /P /K 0 >>",
        ],
    )

    resources, truncation = _collect(path)

    assert resources["document"]["tagged"] is True
    assert resources["document"]["hasStructTreeRoot"] is True
    assert resources["document"]["hasParentTree"] is False
    assert resources["structure"][0]["role"] == "Document"
    assert "parentTreeEntries" not in truncation


def test_output_is_deterministic_and_free_of_paths_and_timestamps(tmp_path):
    path = _tagged_pdf(
        tmp_path / "deterministic.pdf",
        root=b"/RoleMap << /MyP /P >> /K 6 0 R /ParentTree 8 0 R",
        page_attributes=b"/StructParents 0",
        extra_objects=[
            b"<< /Type /StructElem /S /Document /K [7 0 R] >>",
            b"<< /Type /StructElem /S /MyP /Pg 3 0 R /K 0 /Alt (alt) >>",
            b"<< /Nums [0 [6 0 R]] >>",
        ],
    )

    first = _collect(path)
    second = _collect(path)
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)

    payload = json.dumps(first)
    assert str(tmp_path) not in payload
    assert path not in payload
    assert "creationdate" not in payload.lower()
    assert "moddate" not in payload.lower()
    assert not re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", payload)
    # Object ids are internal cycle-protection data, never emitted.
    assert "objid" not in payload
