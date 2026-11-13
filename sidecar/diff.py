"""Object-level PDF diff engine.

The engine is deliberately transport agnostic: the CLI, the HTTP endpoint and
the desktop RPC all call :func:`diff_files` and serialise the returned dict, so
every surface shares one deterministic implementation.

Coordinates are the same MediaBox-relative PDF points the extractor reports;
pages are paired with :class:`difflib.SequenceMatcher` on lightweight page
fingerprints derived from a content signature (see :func:`_page_signature`),
and each object type is matched independently with a deterministic
greedy minimum-cost matcher (stable sorting, no randomness, no timestamps).
File handles are always released, and unreadable PDFs raise
:class:`DiffError` with a human readable message.

Every paired page also carries a ``match`` object: a deterministic 0..1
fingerprint similarity score (:func:`page_match_score`) plus whether the page
ended up at a different ordinal position.  One-sided pages carry
``match: null`` and the object-level change list is unaffected.

``DiffOptions.ignore_regions`` adds drawn, page-scoped masks: a change whose box
on a side intersects a region naming that side's page is filtered out after
object matching (see :func:`change_is_ignored`).  Regions never change how
objects are paired, so removing one restores exactly the masked changes.

Two passes keep the work proportional to what changed:

* the *signature* pass (:func:`_page_signature`) hashes a page's geometry, its
  content streams, its resources and its ``/Annots`` straight from pdfminer
  objects — no pdfplumber layout, no object extraction — and also yields the
  page size;
* the *diff* pass extracts a page pair only when their signatures differ, and
  asks ``PdfExtractor.extract_page`` only for the object types that are neither
  ignored nor excluded.

An unchanged page is therefore never fully extracted, and two byte-identical
files short-circuit to "every page unchanged".

A run stops growing at :data:`MAX_DIFF_CHANGES` changes.  The cap exists so a
pathological pair (a whole page rewritten, character-level diffs of a long text
PDF) cannot produce an unbounded JSON payload; the result then reports
``truncated: true`` and ``summary.changesTruncated: true`` instead of silently
looking complete.  The collector's own caps (per-page/all-document annotation
limits, form limits, metadata/page-label limits) use the same flags and add
``summary.resourcesTruncated: true``: a capped resource block never reports a
clean comparison either.

Document resources
------------------

:mod:`sidecar.diff_resources` collects annotations, links, form widgets, the
info dictionary and ``/PageLabels`` without rendering or opening anything.  The
diff compares them on top of the object diff:

* annotations/links/form widgets are paired per aligned page by the collector's
  stable identity, and their differences join the *same* ``pages[].changes``
  list with ``type`` ``annotation``/``link``/``form``.  They therefore share page
  grouping, ignore-region masking (only entries with a BBox can be masked) and
  the change cap, but they never enter the object counters: the summary counts
  them as ``resourcesAdded``/``resourcesRemoved``/``resourcesModified``/
  ``resourcesMoved``.
* metadata and page labels become ``documentChanges`` entries
  (``type`` ``metadata``/``page-label``) instead of page changes, so a
  metadata-only edit leaves every page ``unchanged``.  ``page-label`` entries
  carry the 1-based page number and are never duplicated into a page's changes.
* the page fast path requires *both* an equal page signature and an equal
  ``page_resource_digest``, so identical objects with edited annotations are
  still reported (and marked ``changed``) instead of being skipped.

An identity that already embeds the rect (every identity except ``/NM`` ones,
including every form identity) changes when the resource moves, so such a move
is reported as one removed plus one added resource rather than ``moved``.  That
is deliberate: guessing a positional match could merge unrelated resources.

The new payload fields are additive and optional: ``documentChanges`` and the
``summary`` resource counters are only present when the run actually compared
resources and found something, so an object-only result keeps its historical
shape.  ``schemaVersion`` stays ``1``.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

from pdfminer.pdftypes import PDFObjRef, PDFStream
from pdfminer.psparser import PSLiteral

try:  # imported as ``sidecar.diff`` (namespace package)
    from .extractor import PdfExtractor
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from extractor import PdfExtractor

try:  # read-only resource collection and digests (see sidecar/diff_resources.py)
    from .diff_resources import collect_document_resources, page_resource_digest
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from diff_resources import collect_document_resources, page_resource_digest


SCHEMA_VERSION = 1
TOOL_NAME = 'pdf-inspector'

# Object types in the order the diff reports and sorts them.
DIFF_TYPES = ('word', 'char', 'rect', 'line', 'curve', 'image', 'table')
TEXT_TYPES = frozenset({'word', 'char'})
TEXT_TOLERANCES = ('exact', 'normalized', 'case-insensitive')

# Page-level resource types, reported after every object type.  A resource
# change uses the same ``DiffChange`` shape as an object change, so it can live
# in ``DiffPage.changes`` and share page grouping, region masking and the
# ``MAX_DIFF_CHANGES`` cap.
RESOURCE_TYPES = ('annotation', 'link', 'form')
# Every type a page-level change list can carry, in report/sort order.
CHANGE_TYPE_ORDER = DIFF_TYPES + RESOURCE_TYPES
_CHANGE_TYPE_ORDER = {name: index for index, name in enumerate(CHANGE_TYPE_ORDER)}
_RESOURCE_TYPE_SET = frozenset(RESOURCE_TYPES)

# ``RESOURCE_TYPES`` -> the collector's per-page key.
_PAGE_RESOURCE_KEYS = {
    'annotation': 'annotations',
    'link': 'links',
    'form': 'forms',
}

# ``RESOURCE_TYPES`` -> the ``DiffOptions`` flag that skips it.
_RESOURCE_IGNORE_ATTRS = {
    'annotation': 'ignore_annotations',
    'link': 'ignore_links',
    'form': 'ignore_forms',
}

# Fields compared per resource kind.  ``rect`` is handled separately because a
# rect-only difference is a *move*, not a modification (see
# ``_resource_change``).  ``identity`` is the R1 identity used to pair entries.
_RESOURCE_FIELDS = {
    'annotation': ('subtype', 'title', 'contents', 'color', 'opacity', 'flags'),
    'link': ('uri', 'internalPage', 'unsafeUrl', 'target', 'action', 'contents'),
    'form': ('fieldType', 'fieldName', 'value', 'defaultValue', 'options', 'flags'),
}

# Field a resource change uses for ``textOld``/``textNew``.
_RESOURCE_TEXT_FIELDS = {
    'annotation': 'contents',
    'link': 'target',
    'form': 'value',
}

# Document-level change types and the metadata fields compared, in report order.
DOCUMENT_CHANGE_TYPES = ('metadata', 'page-label')
_DOCUMENT_TYPE_ORDER = {name: index for index, name in enumerate(DOCUMENT_CHANGE_TYPES)}
METADATA_FIELDS = (
    'title',
    'author',
    'subject',
    'keywords',
    'creator',
    'producer',
    'creationDate',
    'modDate',
    'language',
)
_METADATA_FIELD_ORDER = {name: index for index, name in enumerate(METADATA_FIELDS)}
# Page-label entry keys compared besides the rendered label itself.
_PAGE_LABEL_FIELDS = ('style', 'prefix', 'start')

# Extract ``PageData`` key for each diff object type.
_PAGE_KEYS = {
    'word': 'words',
    'char': 'chars',
    'rect': 'rects',
    'line': 'lines',
    'curve': 'curves',
    'image': 'images',
    'table': 'tables',
}

# How much a text mismatch costs relative to one PDF point of movement when the
# greedy matcher decides between nearby candidates.
_TEXT_WEIGHT = 50.0
# Typical descent share of a glyph's em square; text anchors reconstruct the
# baseline from pdfplumber's full-em bbox (see ``_anchor_point``).
_BASELINE_FROM_BOTTOM = 0.224
# Above this many candidate pairs a same-signature group is paired in reading
# order instead of by cost (deterministic either way, but O(n^2) stays bounded).
_PAIR_LIMIT = 10_000

_KIND_ORDER = {'removed': 0, 'added': 1, 'modified': 2, 'moved': 3}

# Relative weight of each page-fingerprint component in ``page_match_score``.
# The weights sum to 1.0, so two identical fingerprints score exactly 1.0.
_PAGE_MATCH_WEIGHTS = (
    ('size', 0.35),
    ('rotation', 0.10),
    ('text', 0.30),
    ('objects', 0.15),
    ('table', 0.10),
)

# Decimals kept in a reported page match score (JSON stays stable).
_MATCH_SCORE_DECIMALS = 3

# Constant table component of the diff-local fingerprint.  Fingerprints are now
# derived from a page signature (see ``_page_signature``), which covers the
# page's real content, so the table component is a constant for every page and
# identical signatures still score exactly 1.0.
_EMPTY_TABLE_HASH = hashlib.sha256(b'').hexdigest()

# How deep the signature hasher follows indirect references.  Three levels reach
# a page's resource dictionary, the font dictionaries inside it and their
# descriptors; deeper objects (embedded font programs, big masks, …) stop at a
# stable marker so their bytes never enter the digest.  A page's own content
# streams are hashed in full regardless of depth.
_SIGNATURE_MAX_DEPTH = 3

# Signature shared by both sides when the two files are byte-identical: the page
# bytes cannot differ, so hashing them again would be pure waste.
_IDENTICAL_FILE_SIGNATURE = 'identical-file'

# Prefix of the per-side marker used when a page cannot be signature-hashed at
# all (broken page tree, undecodable content).  It differs between the old and
# the new side on purpose: an unprovable page must always be fully compared.
_UNHASHED_SIGNATURE_PREFIX = 'unhashed'

_PACKAGE_JSON = Path(__file__).resolve().parent.parent / 'package.json'

# Stable reference to the concrete extractor class.  Page-level helpers reuse
# its static/class methods (``_resolve_pdf_value``, ``_page_rotation``), and
# that must keep working when ``diff.PdfExtractor`` is replaced by a wrapper —
# the module attribute is the extension point for opening documents, not for
# PDF-value parsing.
_EXTRACTOR_HELPERS = PdfExtractor

# Hard ceiling on the number of changes a single diff reports.
#
# A page whose text was fully rewritten produces one change per character, so a
# long text PDF pair can easily exceed what any consumer (or JSON payload) can
# carry.  The cap bounds both the serialised result and the memory the change
# list needs; ``DiffResult.truncated`` / ``DiffSummary.changesTruncated`` tell a
# consumer that the list is incomplete rather than silently complete.
MAX_DIFF_CHANGES = 50_000


class DiffError(Exception):
    """Raised when a diff input cannot be read or parsed.

    The message is meant for a CLI/user, never a traceback dump.
    """


@dataclass
class DiffOptions:
    """Tunables for :func:`diff_files`.

    ``ignore_fonts`` covers font name and font size; ``ignore_colors`` covers
    stroke/char colour fields; ``ignore_images`` is equivalent to adding
    ``"image"`` to ``ignore_types``; ``ignore_regions`` are page-scoped
    rectangles (MediaBox-relative PDF points) that mask intersecting changes.

    ``ignore_annotations``/``ignore_links``/``ignore_forms`` skip the matching
    page-level resource comparison and ``ignore_metadata``/``ignore_page_labels``
    skip the matching document-level comparison.  All five default to ``False``:
    unlike character-level diffs, annotation/form counts are usually small, so
    resources are compared unless the caller opts out.
    """

    position_tolerance: float = 1.0
    text_tolerance: str = 'normalized'
    ignore_types: set[str] = field(default_factory=set)
    ignore_fonts: bool = False
    ignore_colors: bool = False
    ignore_images: bool = False
    ignore_regions: list[dict[str, Any]] = field(default_factory=list)
    ignore_annotations: bool = False
    ignore_links: bool = False
    ignore_forms: bool = False
    ignore_metadata: bool = False
    ignore_page_labels: bool = False

    def __post_init__(self) -> None:
        try:
            tolerance = float(self.position_tolerance)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f'position_tolerance must be a number, got {self.position_tolerance!r}'
            ) from exc
        if not math.isfinite(tolerance) or tolerance < 0:
            raise ValueError(
                f'position_tolerance must be a finite non-negative number, got {tolerance!r}'
            )
        self.position_tolerance = tolerance
        if self.text_tolerance not in TEXT_TOLERANCES:
            raise ValueError(
                f'text_tolerance must be one of {", ".join(TEXT_TOLERANCES)}, '
                f'got {self.text_tolerance!r}'
            )
        ignored = {str(value) for value in (self.ignore_types or ())}
        unknown = sorted(ignored - set(DIFF_TYPES))
        if unknown:
            raise ValueError(
                f'Unknown ignore type(s): {", ".join(unknown)} '
                f'(valid: {", ".join(DIFF_TYPES)})'
            )
        self.ignore_types = ignored
        self.ignore_regions = normalize_ignore_regions(self.ignore_regions)


# --- ignore regions ---------------------------------------------------------

# A region is accepted with the CLI/JSON contract's camelCase keys and with the
# RPC's snake_case keys, so one normaliser serves both surfaces.
_REGION_KEY_PAIRS = (('oldPage', 'old_page'), ('newPage', 'new_page'))
_REGION_KEYS = frozenset(
    ['bbox'] + [name for pair in _REGION_KEY_PAIRS for name in pair]
)
_BBOX_KEYS = ('x0', 'y0', 'x1', 'y1')


def _region_page(value: Any, name: str, index: int) -> Optional[int]:
    """A 1-based page number or ``None``; anything else is rejected."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(
            f'ignore_regions[{index}].{name} must be a positive page number or null, '
            f'got {value!r}'
        )
    number = float(value)
    if not math.isfinite(number) or number < 1 or number != int(number):
        raise ValueError(
            f'ignore_regions[{index}].{name} must be a positive page number or null, '
            f'got {value!r}'
        )
    return int(number)


def _region_bbox(value: Any, index: int) -> dict[str, float]:
    if not isinstance(value, Mapping):
        raise ValueError(
            f'ignore_regions[{index}].bbox must be an object with x0/y0/x1/y1'
        )
    unknown = sorted(set(value) - set(_BBOX_KEYS))
    if unknown:
        raise ValueError(
            f'ignore_regions[{index}].bbox has unknown key(s): {", ".join(unknown)}'
        )

    coordinates: dict[str, float] = {}
    for key in _BBOX_KEYS:
        if key not in value:
            raise ValueError(f'ignore_regions[{index}].bbox.{key} is required')
        raw = value[key]
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ValueError(
                f'ignore_regions[{index}].bbox.{key} must be a finite number, got {raw!r}'
            )
        number = float(raw)
        if not math.isfinite(number):
            raise ValueError(f'ignore_regions[{index}].bbox.{key} must be finite')
        coordinates[key] = number

    if coordinates['x0'] > coordinates['x1'] or coordinates['y0'] > coordinates['y1']:
        raise ValueError(
            f'ignore_regions[{index}].bbox must be ordered '
            '(x0 <= x1 and y0 <= y1)'
        )
    return coordinates


def _region_field(region: Mapping[str, Any], camel: str, snake: str, index: int) -> Any:
    has_camel = camel in region
    has_snake = snake in region
    if has_camel and has_snake:
        raise ValueError(
            f'ignore_regions[{index}] must not combine {camel} and {snake}'
        )
    if has_camel:
        return region[camel]
    if has_snake:
        return region[snake]
    return None


def normalize_ignore_regions(regions: Any) -> list[dict[str, Any]]:
    """Validate ignore regions and return them in the contract's camelCase shape.

    Regions name a page pair (``oldPage``/``newPage``, 1-based or ``None``) and a
    MediaBox-relative ``bbox``. Reversed boxes, non-finite coordinates, page
    numbers below 1 and regions that name no page raise :class:`ValueError`: the
    engine never silently drops a mask the caller asked for.
    """
    if regions is None:
        return []
    if isinstance(regions, (str, bytes, bytearray, Mapping)) or not isinstance(
        regions, Iterable
    ):
        raise ValueError('ignore_regions must be a list of regions')

    normalized: list[dict[str, Any]] = []
    for index, region in enumerate(regions):
        if not isinstance(region, Mapping):
            raise ValueError(f'ignore_regions[{index}] must be an object')
        unknown = sorted(set(region) - _REGION_KEYS)
        if unknown:
            raise ValueError(
                f'ignore_regions[{index}] has unknown key(s): {", ".join(unknown)}'
            )

        pages = {
            camel: _region_page(_region_field(region, camel, snake, index), camel, index)
            for camel, snake in _REGION_KEY_PAIRS
        }
        if pages['oldPage'] is None and pages['newPage'] is None:
            raise ValueError(
                f'ignore_regions[{index}] must name at least one page '
                '(oldPage or newPage)'
            )

        normalized.append(
            {
                'oldPage': pages['oldPage'],
                'newPage': pages['newPage'],
                'bbox': _region_bbox(region.get('bbox'), index),
            }
        )
    return normalized


def _box_coordinates(box: Any) -> Optional[tuple[float, float, float, float]]:
    if not isinstance(box, Mapping):
        return None
    try:
        return (
            float(box['x0']),
            float(box['y0']),
            float(box['x1']),
            float(box['y1']),
        )
    except (KeyError, TypeError, ValueError):
        return None


def bbox_intersects(left: Any, right: Any) -> bool:
    """True when two MediaBox-relative boxes overlap; touching edges count.

    A missing/invalid box never intersects, so an added object (no ``oldBBox``)
    is only masked by a region on its new side.
    """
    left_coords = _box_coordinates(left)
    right_coords = _box_coordinates(right)
    if left_coords is None or right_coords is None:
        return False
    left_x0, left_y0, left_x1, left_y1 = left_coords
    right_x0, right_y0, right_x1, right_y1 = right_coords
    return (
        left_x0 <= right_x1
        and right_x0 <= left_x1
        and left_y0 <= right_y1
        and right_y0 <= left_y1
    )


def change_is_ignored(change: Mapping[str, Any], options: DiffOptions) -> bool:
    """True when a region masks this change on either side.

    Regions are matched by page *and* box: a region on old page 2 never hides a
    change on old page 3, even when the boxes overlap. One-sided objects carry
    ``None`` for the missing side, so only the existing side's region applies.
    """
    if not options.ignore_regions:
        return False
    for region in options.ignore_regions:
        bbox = region['bbox']
        if (
            region['oldPage'] is not None
            and change.get('oldPage') == region['oldPage']
            and bbox_intersects(change.get('oldBBox'), bbox)
        ):
            return True
        if (
            region['newPage'] is not None
            and change.get('newPage') == region['newPage']
            and bbox_intersects(change.get('newBBox'), bbox)
        ):
            return True
    return False


def _without_ignored_changes(
    changes: Iterable[dict[str, Any]],
    options: DiffOptions,
) -> list[dict[str, Any]]:
    """Drop masked changes after matching, so a removed region restores them.

    Matching deliberately runs on the unmasked object sets: filtering afterwards
    keeps the object pairing (and therefore the remaining changes) identical
    whether or not a region is drawn.
    """
    if not options.ignore_regions:
        return list(changes)
    return [change for change in changes if not change_is_ignored(change, options)]



# --- small numeric / text helpers -------------------------------------------


def _number(value: Any, default: float = 0.0) -> float:
    """Coerce a PDF numeric field to a finite float, or ``default``."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def normalize_text(text: Any, mode: str = 'normalized') -> str:
    """Normalise an object's text for ``text_tolerance`` comparisons.

    ``exact`` keeps the raw text, ``normalized`` collapses whitespace runs and
    strips the ends (case preserved), ``case-insensitive`` also casefolds.
    """
    value = '' if text is None else str(text)
    if mode == 'exact':
        return value
    collapsed = ' '.join(value.split())
    if mode == 'case-insensitive':
        return collapsed.casefold()
    return collapsed


def _text_similarity(left: str, right: str) -> float:
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0
    return difflib.SequenceMatcher(None, left, right, autojunk=False).ratio()


def _bbox(obj: Optional[Mapping[str, Any]]) -> Optional[dict[str, float]]:
    if not obj:
        return None
    return {
        'x0': _number(obj.get('x0')),
        'y0': _number(obj.get('y0')),
        'x1': _number(obj.get('x1')),
        'y1': _number(obj.get('y1')),
    }


def _center(obj: Mapping[str, Any]) -> tuple[float, float]:
    return (
        (_number(obj.get('x0')) + _number(obj.get('x1'))) / 2.0,
        (_number(obj.get('y0')) + _number(obj.get('y1'))) / 2.0,
    )


def _center_distance(left: Mapping[str, Any], right: Mapping[str, Any]) -> float:
    lx, ly = _center(left)
    rx, ry = _center(right)
    return math.hypot(lx - rx, ly - ry)


def _anchor_point(obj: Mapping[str, Any]) -> tuple[float, float]:
    """Text anchor: the bbox left edge and an estimated baseline.

    pdfplumber reports glyph boxes spanning the whole em square, so the bottom
    edge itself moves when the font size changes.  Reconstructing the baseline
    from the bottom edge plus the typical descent fraction keeps "same text at
    the same place" stable across font-size changes, while genuine moves (both
    horizontal and vertical) still shift the anchor.
    """
    y0 = _number(obj.get('y0'))
    height = abs(_number(obj.get('y1')) - y0)
    return (_number(obj.get('x0')), y0 + _BASELINE_FROM_BOTTOM * height)


def _anchor_distance(left: Mapping[str, Any], right: Mapping[str, Any]) -> float:
    lx, ly = _anchor_point(left)
    rx, ry = _anchor_point(right)
    return math.hypot(lx - rx, ly - ry)


def _size(obj: Mapping[str, Any]) -> tuple[float, float]:
    return (
        _number(obj.get('x1')) - _number(obj.get('x0')),
        _number(obj.get('y1')) - _number(obj.get('y0')),
    )


def _rounded_points(points: Any) -> list[list[float]]:
    result = []
    for point in points or ():
        try:
            result.append([round(_number(point[0]), 3), round(_number(point[1]), 3)])
        except (TypeError, IndexError):
            result.append([0.0, 0.0])
    return result


def _reading_order(indices: Iterable[int], objects: Sequence[Mapping[str, Any]]) -> list[int]:
    """Sort indices top-to-bottom, left-to-right; fully deterministic."""

    def key(index: int) -> tuple[float, float, float, float, int]:
        obj = objects[index]
        return (
            -round(_number(obj.get('y1')), 3),
            round(_number(obj.get('x0')), 3),
            -round(_number(obj.get('y0')), 3),
            round(_number(obj.get('x1')), 3),
            index,
        )

    return sorted(indices, key=key)


# --- page fingerprints and pairing ------------------------------------------


def page_fingerprint(page: Mapping[str, Any]) -> tuple:
    """A lightweight, hashable page identity used only for page alignment.

    It intentionally ignores colours, fonts and image bytes: those are object
    level changes, not page identity.  Whitespace-normalised word text plus the
    per-type object counts and table cell text is enough to recognise an
    inserted or removed page without extracting object diffs.

    :func:`diff_files` does not call this: it builds fingerprints from a page
    signature (:func:`_signature_fingerprint`) so that an unchanged page is
    recognised without any layout parse.  This function stays the reference
    implementation for callers that already hold extracted page dicts.
    """
    width = round(_number(page.get('width')), 2)
    height = round(_number(page.get('height')), 2)
    rotation = int(_number(page.get('rotation'))) % 360

    words = page.get(_PAGE_KEYS['word']) or []
    word_text = '\x1f'.join(
        normalize_text(word.get('text', ''), 'normalized') for word in words
    )
    text_hash = hashlib.sha256(word_text.encode('utf-8')).hexdigest()

    counts = tuple((type_, len(page.get(_PAGE_KEYS[type_]) or ())) for type_ in DIFF_TYPES)

    table_chunks = []
    for table in page.get(_PAGE_KEYS['table']) or ():
        for row in table.get('cells') or ():
            table_chunks.append(
                '\x1f'.join(normalize_text(cell, 'normalized') for cell in (row or ()))
            )
        table_chunks.append('\x1e')
    table_hash = hashlib.sha256('\x1d'.join(table_chunks).encode('utf-8')).hexdigest()

    return (width, height, rotation, text_hash, counts, table_hash)


def _page_rotation(page: Any) -> int:
    """Read ``/Rotate`` from a pdfplumber page exactly like ``_page_geometry``.

    Kept in sync with :meth:`PdfExtractor._page_geometry` so the alignment key
    (and the page geometry change reported for a paired page) sees the same
    normalised rotation the extractor reports.
    """
    page_obj = getattr(page, 'page_obj', None)
    attrs = _EXTRACTOR_HELPERS._resolve_pdf_value(getattr(page_obj, 'attrs', None))
    if not isinstance(attrs, dict):
        attrs = {}
    return _EXTRACTOR_HELPERS._page_rotation(attrs)


# --- page signatures --------------------------------------------------------


class _PageSignatureHasher:
    """Stable SHA-256 digest over one page's geometry, content and resources.

    The digest is built from pdfminer objects only, so it never triggers a
    pdfplumber layout or an object extraction.  Two pages produce the same digest
    exactly when their drawing program, their page boxes/rotation and the
    resources they reference are the same.

    Stability rules (this digest is compared across two documents, not just
    within one):

    - numbers are normalised through ``float`` so ``0`` and ``0.0`` agree;
    - mapping keys are hashed in sorted order, lists in their own order;
    - indirect references contribute the *content they point at*, not their
      object number: the same page copied into another file (or re-saved) gets
      different object numbers but must still hash identically;
    - a reference seen before in this page hashes as a stable revisit marker, so
      shared resources and cyclic graphs terminate;
    - references past :data:`_SIGNATURE_MAX_DEPTH` hash as a stable marker rather
      than being followed, which keeps embedded font programs and large masks
      out of the digest — and, crucially, keeps the digest independent of object
      numbering.
    """

    def __init__(self, max_depth: int = _SIGNATURE_MAX_DEPTH) -> None:
        self._digest = hashlib.sha256()
        self._max_depth = max_depth
        # ``id()`` of resolved reference targets / streams already hashed for
        # this page.  Those come from pdfminer's document cache, so they stay
        # alive (and their ids stable) while the page is being hashed.
        self._seen: set[int] = set()

    # -- writing helpers ----------------------------------------------------

    def _tag(self, name: str) -> None:
        """Write a structural marker so concatenations cannot collide."""
        self._digest.update(b'\x1e')
        self._digest.update(name.encode('ascii'))
        self._digest.update(b'\x1f')

    def _chunk(self, data: bytes) -> None:
        """Write a length-prefixed payload (delimiters, no ambiguity)."""
        self._digest.update(b'\x1d')
        self._digest.update(str(len(data)).encode('ascii'))
        self._digest.update(b':')
        self._digest.update(data)

    def hexdigest(self) -> str:
        return self._digest.hexdigest()

    # -- value traversal ----------------------------------------------------

    @staticmethod
    def _key_bytes(key: Any) -> bytes:
        """Sort key for a mapping key (names, strings and raw bytes coexist)."""
        if isinstance(key, PSLiteral):
            return b'\x00' + str(key.name).encode('utf-8', 'replace')
        if isinstance(key, str):
            return b'\x01' + key.encode('utf-8', 'replace')
        if isinstance(key, (bytes, bytearray, memoryview)):
            return b'\x02' + bytes(key)
        return b'\x03' + repr(key).encode('utf-8', 'replace')

    def value(self, value: Any, depth: int = 0) -> None:
        """Hash one PDF value; unknown objects contribute only their type name."""
        if value is None:
            self._tag('none')
        elif isinstance(value, bool):
            self._tag('true' if value else 'false')
        elif isinstance(value, (int, float)):
            # int/float are folded together: writers disagree on 0 vs 0.0.
            self._tag('number')
            self._chunk(repr(float(value)).encode('ascii', 'replace'))
        elif isinstance(value, str):
            self._tag('string')
            self._chunk(value.encode('utf-8', 'replace'))
        elif isinstance(value, (bytes, bytearray, memoryview)):
            self._tag('bytes')
            self._chunk(bytes(value))
        elif isinstance(value, PSLiteral):
            self._tag('name')
            self._chunk(str(value.name).encode('utf-8', 'replace'))
        elif isinstance(value, PDFObjRef):
            self._reference(value, depth)
        elif isinstance(value, PDFStream):
            self._stream(value)
        elif isinstance(value, Mapping):
            self._mapping(value, depth)
        elif isinstance(value, (list, tuple)):
            self._sequence(value, depth)
        else:
            self._tag('object')
            self._chunk(type(value).__name__.encode('ascii', 'replace'))

    def _mapping(self, mapping: Mapping, depth: int) -> None:
        # No revisit tracking here: PDF dictionaries cannot contain themselves
        # without going through an indirect reference, and those are tracked by
        # ``_reference``.  Tracking transient dicts by ``id()`` would be unsafe
        # (ids get reused once a dict is collected).
        self._tag('mapping')
        self._chunk(str(len(mapping)).encode('ascii'))
        for key in sorted(mapping, key=self._key_bytes):
            self.value(key, depth)
            self.value(mapping[key], depth)

    def _sequence(self, sequence: Sequence, depth: int) -> None:
        self._tag('sequence')
        self._chunk(str(len(sequence)).encode('ascii'))
        for item in sequence:
            self.value(item, depth)

    def _reference(self, ref: PDFObjRef, depth: int) -> None:
        """Hash what an indirect reference points at, not its object number."""
        if depth > self._max_depth:
            # Stable marker: following the reference could pull an embedded font
            # program (megabytes) into the digest, and hashing its object number
            # would make the page identity depend on the file's object layout.
            self._tag('reference-limit')
            return

        try:
            target = ref.resolve()
        except Exception:
            self._tag('reference-broken')
            return

        if target is None:
            self._tag('reference-empty')
            return

        # Resolved targets are pdfminer document objects, so their ``id()`` is
        # stable while the page is hashed: revisits (shared resources, cycles)
        # hash as a marker instead of being followed again.
        if id(target) in self._seen:
            self._tag('reference-revisit')
            return
        self._seen.add(id(target))

        self._tag('reference')
        self.value(target, depth + 1)

    def _stream(self, stream: PDFStream) -> None:
        """Hash a stream as its attributes plus its decoded bytes."""
        if id(stream) in self._seen:
            self._tag('stream-revisit')
            return
        self._seen.add(id(stream))
        self._tag('stream')
        self.value(getattr(stream, 'attrs', None))
        try:
            data = stream.get_data()
        except Exception:
            self._tag('stream-undecodable')
            return
        self._chunk(bytes(data))


def _page_signature(
    extractor: PdfExtractor,
    page_num: int,
    path: Path,
    label: str,
) -> tuple[str, float, float]:
    """Content signature of one page, without any layout parse.

    Returns ``(signature_hex, width, height)``.  The digest covers the
    normalised MediaBox/CropBox, ``/Rotate``, every content stream (decoded, in
    page order), the page's resource dictionary — including the fonts and
    images it references, which is what separates "same drawing program" from
    "same appearance" — and the page's ``/Annots`` array, so a page whose
    objects are identical but whose annotations/links/form widgets changed is
    never treated as fast-path unchanged.  ``page.chars`` is never touched and
    ``extract_page`` is never called, so a page costs a few milliseconds at
    most.

    A page whose signature cannot be computed gets a per-side marker instead of
    an exception: two markers never compare equal, which forces the full
    comparison for that page rather than skipping it.
    """
    try:
        page = extractor._pdf.pages[page_num - 1]  # pdfplumber is 0-indexed
        page_obj = getattr(page, 'page_obj', None)
        width = float(getattr(page, 'width', 0) or 0)
        height = float(getattr(page, 'height', 0) or 0)
    except Exception as exc:
        raise DiffError(
            f'Cannot read page {page_num} of {label} PDF {str(path)!r}: {exc}'
        ) from exc

    try:
        attrs = _EXTRACTOR_HELPERS._resolve_pdf_value(getattr(page_obj, 'attrs', None))
        if not isinstance(attrs, dict):
            attrs = {}

        hasher = _PageSignatureHasher()
        hasher._tag('geometry')
        for name in ('MediaBox', 'CropBox'):
            hasher._tag(name)
            hasher.value(_EXTRACTOR_HELPERS._normalize_box(attrs.get(name)))
        hasher._tag('Rotate')
        hasher.value(_EXTRACTOR_HELPERS._page_rotation(attrs))
        hasher._tag('Contents')
        hasher.value(getattr(page_obj, 'contents', None))
        hasher._tag('Resources')
        hasher.value(getattr(page_obj, 'resources', None))
        # Annotations are part of the page identity too: identical objects with
        # a different annotation/URI/form value must reach the full comparison
        # instead of being skipped by the fast path.  A page without /Annots
        # hashes the same "none" marker on both sides, so its equality is
        # unchanged.
        hasher._tag('Annots')
        hasher.value(attrs.get('Annots'))
        signature = hasher.hexdigest()
    except Exception:
        # Unprovable page: a marker that can never equal the other side's.
        signature = f'{_UNHASHED_SIGNATURE_PREFIX}:{label}:{page_num}'
    finally:
        _release_page_layout(extractor, page_num)

    return (signature, width, height)


def _identical_file_signature(
    extractor: PdfExtractor,
    page_num: int,
    path: Path,
    label: str,
) -> tuple[str, float, float]:
    """Signature for a page of two byte-identical files.

    The bytes cannot differ, so hashing them again would be pure waste: only the
    page size is read (a page-dictionary lookup, no layout).  Because the same
    list is reused for both sides, every pair compares equal without hashing.
    """
    try:
        page = extractor._pdf.pages[page_num - 1]
        return (
            _IDENTICAL_FILE_SIGNATURE,
            float(getattr(page, 'width', 0) or 0),
            float(getattr(page, 'height', 0) or 0),
        )
    except Exception as exc:
        raise DiffError(
            f'Cannot read page {page_num} of {label} PDF {str(path)!r}: {exc}'
        ) from exc


def _signature_size(signature: tuple[str, float, float]) -> dict[str, float]:
    """``oldSize``/``newSize`` payload built from a signature."""
    return {'width': _number(signature[1]), 'height': _number(signature[2])}


# --- page alignment keys ----------------------------------------------------

# String literals of a PDF content stream, i.e. the text a page draws.
#
# The alignment key below only needs a *coarse* page identity — "is this the same
# page, possibly edited?" — while the signature answers the exact question.  A
# page's drawn text is that coarse identity: it survives moving a word, changing
# a font or a colour, which is exactly what should not stop two versions of a
# page from being paired.
def _content_literals(data: bytes) -> list[bytes]:
    """Text literals of one decoded content stream, in stream order.

    Handles ``( … )`` strings (nesting and ``\\`` escapes) and ``< … >`` hex
    strings, which is where PDF text operators take their payload.  The result
    feeds a hash, so a rare mis-split only costs a little alignment accuracy.
    """
    literals: list[bytes] = []
    index, length = 0, len(data)
    while index < length:
        char = data[index]
        if char == 0x28:  # '('
            depth = 1
            index += 1
            start = index
            while index < length and depth:
                current = data[index]
                if current == 0x5C:  # backslash escapes the next byte
                    index += 2
                    continue
                if current == 0x28:
                    depth += 1
                elif current == 0x29:
                    depth -= 1
                    if depth == 0:
                        break
                index += 1
            literals.append(bytes(data[start:index]))
            index += 1
            continue
        if char == 0x3C and index + 1 < length and data[index + 1] != 0x3C:  # '<'
            end = data.find(b'>', index + 1)
            if end < 0:
                break
            literals.append(bytes(data[index + 1:end]))
            index = end + 1
            continue
        index += 1
    return literals


def _page_alignment_key(
    extractor: PdfExtractor,
    page_num: int,
    path: Path,
    label: str,
) -> tuple:
    """Coarse page identity used only to align the two documents.

    ``pair_pages`` needs "same page, possibly edited", not "byte-identical
    page": a page that was reordered *and* had a word moved must still be paired
    with its counterpart, otherwise it degrades into one removed and one added
    page.  The key is therefore the page box/rotation plus the multiset of text
    literals its content streams draw — no layout, no positions, no fonts.

    Returns a hashable tuple; an unreadable page gets a unique key so it can
    never be paired by accident.
    """
    try:
        page = extractor._pdf.pages[page_num - 1]
        page_obj = getattr(page, 'page_obj', None)
        width = round(_number(getattr(page, 'width', 0)), 2)
        height = round(_number(getattr(page, 'height', 0)), 2)
        rotation = int(_number(_page_rotation(page))) % 360
        contents = getattr(page_obj, 'contents', None) or []
        literals: list[bytes] = []
        for stream in contents if isinstance(contents, (list, tuple)) else [contents]:
            literals.extend(_content_literals(bytes(stream.get_data())))
    except Exception:
        return ('unaligned', label, page_num)

    # Sorted, so that moving a word on the page keeps the page aligned; the
    # surrounding tuple keeps pages of a different size apart.
    skeleton = hashlib.sha256(b'\x1f'.join(sorted(literals))).hexdigest()
    return (width, height, rotation, skeleton)


def _signature_fingerprint(signature: tuple[str, float, float]) -> tuple:
    """Page fingerprint built from a page signature.

    Same 6-tuple shape :func:`page_fingerprint` produces, but the "text hash"
    slot carries the whole-page signature: two pages are considered the same
    exactly when their signatures match, so ``page_match_score`` is 1.0 for an
    unchanged pair and a constant 0.7 (size/rotation/counts still agree) for a
    changed one.  ``/Rotate`` is already inside the signature, hence the 0 here.
    """
    signature_hash, width, height = signature
    counts = tuple((type_, 0) for type_ in DIFF_TYPES)
    return (
        round(_number(width), 2),
        round(_number(height), 2),
        0,
        signature_hash,
        counts,
        _EMPTY_TABLE_HASH,
    )


def _proportion_similarity(left: float, right: float) -> float:
    """``1.0`` when both numbers are equal, decaying as the larger one grows."""
    left = abs(_number(left))
    right = abs(_number(right))
    if left == right:
        return 1.0
    larger = max(left, right)
    if larger <= 0:
        return 1.0
    return min(left, right) / larger


def _fingerprint_parts(
    fingerprint: Any,
) -> Optional[tuple[float, float, int, Any, dict[str, int], Any]]:
    """Split a :func:`page_fingerprint` tuple, or ``None`` for an unknown shape."""
    try:
        width, height, rotation, text_hash, counts, table_hash = fingerprint
        count_map = {str(type_): int(count) for type_, count in counts}
    except (TypeError, ValueError):
        return None
    return (
        _number(width),
        _number(height),
        int(_number(rotation)),
        text_hash,
        count_map,
        table_hash,
    )


def page_match_score(old_fp: Any, new_fp: Any) -> float:
    """Deterministic ``0..1`` similarity between two page fingerprints.

    A fingerprint deliberately keeps hashes and counts instead of page text, so
    the score measures how much of the page identity survived:

    - page width/height similarity contributes proportionally;
    - rotation, the whitespace-normalised word-text hash and the table-cell
      hash are exact-match components;
    - per-type object counts contribute the mean of their proportions, so
      adding one rectangle to a dense page barely moves the score.

    Identical fingerprints score exactly ``1.0``; anything else is the weighted
    sum below, clamped to ``0..1`` and rounded to 3 decimals so JSON output
    stays stable.  ``None`` input (a one-sided page) scores ``0.0``.
    """
    if old_fp is None or new_fp is None:
        return 0.0
    if old_fp == new_fp:
        return 1.0

    old_parts = _fingerprint_parts(old_fp)
    new_parts = _fingerprint_parts(new_fp)
    if old_parts is None or new_parts is None:
        return 0.0

    old_width, old_height, old_rotation, old_text, old_counts, old_table = old_parts
    new_width, new_height, new_rotation, new_text, new_counts, new_table = new_parts

    components = {
        'size': (
            _proportion_similarity(old_width, new_width)
            + _proportion_similarity(old_height, new_height)
        )
        / 2.0,
        'rotation': 1.0 if old_rotation == new_rotation else 0.0,
        'text': 1.0 if old_text == new_text else 0.0,
        'objects': sum(
            _proportion_similarity(old_counts.get(type_, 0), new_counts.get(type_, 0))
            for type_ in DIFF_TYPES
        )
        / len(DIFF_TYPES),
        'table': 1.0 if old_table == new_table else 0.0,
    }

    score = sum(weight * components[name] for name, weight in _PAGE_MATCH_WEIGHTS)
    return round(min(max(score, 0.0), 1.0), _MATCH_SCORE_DECIMALS)


def pair_pages(
    old_fingerprints: Sequence[Any],
    new_fingerprints: Sequence[Any],
) -> list[tuple[Optional[int], Optional[int]]]:
    """Align pages, returning 1-based ``(oldIndex, newIndex)`` pairs in order.

    ``None`` marks a page that only exists on one side.  SequenceMatcher turns
    duplicate pages into insert/delete/replace opcodes; replace segments are
    paired in their relative order.  If alignment somehow yields no pair at
    all, identical indices are used as the documented fallback.
    """
    old_sequence = list(old_fingerprints)
    new_sequence = list(new_fingerprints)
    pairs: list[tuple[Optional[int], Optional[int]]] = []

    matcher = difflib.SequenceMatcher(a=old_sequence, b=new_sequence, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            for offset in range(i2 - i1):
                pairs.append((i1 + offset + 1, j1 + offset + 1))
        elif tag == 'replace':
            old_span = list(range(i1, i2))
            new_span = list(range(j1, j2))
            overlap = min(len(old_span), len(new_span))
            for offset in range(overlap):
                pairs.append((old_span[offset] + 1, new_span[offset] + 1))
            for index in old_span[overlap:]:
                pairs.append((index + 1, None))
            for index in new_span[overlap:]:
                pairs.append((None, index + 1))
        elif tag == 'delete':
            for index in range(i1, i2):
                pairs.append((index + 1, None))
        elif tag == 'insert':
            for index in range(j1, j2):
                pairs.append((None, index + 1))

    if old_sequence and new_sequence and not any(
        old_index is not None and new_index is not None for old_index, new_index in pairs
    ):
        # Documented fallback: same index, extras appended in order.
        pairs = []
        overlap = min(len(old_sequence), len(new_sequence))
        for index in range(overlap):
            pairs.append((index + 1, index + 1))
        for index in range(overlap, len(old_sequence)):
            pairs.append((index + 1, None))
        for index in range(overlap, len(new_sequence)):
            pairs.append((None, index + 1))

    return pairs


# --- deterministic matching primitives --------------------------------------


def _greedy(candidates: Sequence[tuple[float, int, int]]) -> list[tuple[int, int]]:
    """Greedy minimum-cost bipartite matching from pre-sorted candidates."""
    used_old: set[int] = set()
    used_new: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for _, old_index, new_index in sorted(candidates):
        if old_index in used_old or new_index in used_new:
            continue
        used_old.add(old_index)
        used_new.add(new_index)
        pairs.append((old_index, new_index))
    return pairs


def _near_candidates(
    old_objects: Sequence[Mapping[str, Any]],
    new_objects: Sequence[Mapping[str, Any]],
    tolerance: float,
    text_mode: Optional[str] = None,
    anchored: bool = False,
) -> list[tuple[float, int, int]]:
    """All pairs whose positions are within ``tolerance``, sorted by cost.

    ``anchored`` uses the bbox bottom-left (the writing origin) instead of the
    centre: text that changed length keeps its anchor, so "same place, new
    text" is still recognised as one modified object.

    A uniform grid keyed by ``tolerance`` keeps this linear-ish even for pages
    with thousands of characters; the neighbourhood search covers boundary
    cases because the cell size equals the search radius.
    """
    if tolerance < 0 or not old_objects or not new_objects:
        return []

    def point(obj: Mapping[str, Any]) -> tuple[float, float]:
        return _anchor_point(obj) if anchored else _center(obj)

    def distance(left: Mapping[str, Any], right: Mapping[str, Any]) -> float:
        lx, ly = point(left)
        rx, ry = point(right)
        return math.hypot(lx - rx, ly - ry)

    cell = max(tolerance, 1e-6)
    buckets: dict[tuple[int, int], list[int]] = {}
    for new_index, obj in enumerate(new_objects):
        px, py = point(obj)
        key = (math.floor(px / cell), math.floor(py / cell))
        buckets.setdefault(key, []).append(new_index)

    old_keys = (
        [normalize_text(obj.get('text', ''), text_mode) for obj in old_objects]
        if text_mode is not None
        else None
    )
    new_keys = (
        [normalize_text(obj.get('text', ''), text_mode) for obj in new_objects]
        if text_mode is not None
        else None
    )

    candidates: list[tuple[float, int, int]] = []
    for old_index, obj in enumerate(old_objects):
        px, py = point(obj)
        base_x, base_y = math.floor(px / cell), math.floor(py / cell)
        seen: set[int] = set()
        for delta_x in (-1, 0, 1):
            for delta_y in (-1, 0, 1):
                for new_index in buckets.get((base_x + delta_x, base_y + delta_y), ()):
                    if new_index in seen:
                        continue
                    seen.add(new_index)
                    gap = distance(obj, new_objects[new_index])
                    if gap > tolerance + 1e-9:
                        continue
                    cost = gap
                    if old_keys is not None:
                        cost += _TEXT_WEIGHT * (
                            1.0 - _text_similarity(old_keys[old_index], new_keys[new_index])
                        )
                    candidates.append((round(cost, 6), old_index, new_index))
    candidates.sort()
    return candidates


def _pair_group(
    old_indices: Sequence[int],
    new_indices: Sequence[int],
    old_objects: Sequence[Mapping[str, Any]],
    new_objects: Sequence[Mapping[str, Any]],
    anchored: bool = False,
) -> list[tuple[int, int]]:
    """Pair two candidate groups (same text/signature) deterministically."""
    if not old_indices or not new_indices:
        return []
    if len(old_indices) * len(new_indices) <= _PAIR_LIMIT:
        measure = _anchor_distance if anchored else _center_distance
        candidates = [
            (
                round(measure(old_objects[old_index], new_objects[new_index]), 6),
                old_index,
                new_index,
            )
            for old_index in old_indices
            for new_index in new_indices
        ]
        return _greedy(candidates)
    return list(
        zip(
            _reading_order(old_indices, old_objects),
            _reading_order(new_indices, new_objects),
        )
    )


# --- change construction ----------------------------------------------------


def _make_change(
    kind: str,
    type_: str,
    old_page: Optional[int],
    new_page: Optional[int],
    old_obj: Optional[Mapping[str, Any]] = None,
    new_obj: Optional[Mapping[str, Any]] = None,
    text_old: Optional[str] = None,
    text_new: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    return {
        'kind': kind,
        'type': type_,
        'oldPage': old_page,
        'newPage': new_page,
        'oldBBox': _bbox(old_obj),
        'newBBox': _bbox(new_obj),
        'textOld': text_old,
        'textNew': text_new,
        'details': details or {},
    }


def _change_sort_key(change: Mapping[str, Any]) -> tuple:
    """Report order: type, then top-to-bottom/left-to-right, then kind.

    Resource types sort after every object type (``CHANGE_TYPE_ORDER``), so a
    page lists its drawn objects first and its annotations/links/form fields
    after them.
    """
    bbox = change.get('oldBBox') or change.get('newBBox') or {}
    return (
        _CHANGE_TYPE_ORDER.get(str(change.get('type')), len(CHANGE_TYPE_ORDER)),
        -round(_number(bbox.get('y1')), 3),
        round(_number(bbox.get('x0')), 3),
        -round(_number(bbox.get('y0')), 3),
        round(_number(bbox.get('x1')), 3),
        _KIND_ORDER.get(change['kind'], 9),
        change.get('textOld') or '',
        change.get('textNew') or '',
        json.dumps(change.get('details') or {}, sort_keys=True, ensure_ascii=False),
    )


def _sort_changes(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(changes, key=_change_sort_key)


def _text_style_details(
    old: Mapping[str, Any],
    new: Mapping[str, Any],
    options: DiffOptions,
    include_color: bool,
) -> dict[str, Any]:
    details: dict[str, Any] = {}
    if not options.ignore_fonts:
        old_font = str(old.get('fontname') or '')
        new_font = str(new.get('fontname') or '')
        if old_font != new_font:
            details['fontName'] = {'old': old_font, 'new': new_font}
        old_size = round(_number(old.get('size')), 3)
        new_size = round(_number(new.get('size')), 3)
        if old_size != new_size:
            details['fontSize'] = {'old': old_size, 'new': new_size}
    if include_color and not options.ignore_colors:
        old_color = str(old.get('color') or '')
        new_color = str(new.get('color') or '')
        if old_color != new_color:
            details['color'] = {'old': old_color, 'new': new_color}
    return details


def _geometry_signature(type_: str, obj: Mapping[str, Any]) -> tuple:
    """Identity of a non-text object, independent of its position."""
    if type_ == 'rect':
        width, height = _size(obj)
        return (
            'rect',
            round(width, 2),
            round(height, 2),
            bool(obj.get('fill')),
            bool(obj.get('stroke')),
        )
    if type_ == 'line':
        delta_x = _number(obj.get('x1')) - _number(obj.get('x0'))
        delta_y = _number(obj.get('y1')) - _number(obj.get('y0'))
        length = math.hypot(delta_x, delta_y)
        angle = math.degrees(math.atan2(delta_y, delta_x)) % 360
        return ('line', round(length, 2), round(angle, 1), bool(obj.get('stroke')))
    if type_ == 'curve':
        width, height = _size(obj)
        return (
            'curve',
            len(obj.get('points') or ()),
            round(width, 2),
            round(height, 2),
            bool(obj.get('stroke')),
        )
    if type_ == 'image':
        content_hash = obj.get('content_hash')
        if isinstance(content_hash, str) and content_hash:
            return ('image', content_hash)
        return (
            'image',
            round(_number(obj.get('width')), 2),
            round(_number(obj.get('height')), 2),
        )
    if type_ == 'table':
        width, height = _size(obj)
        cells = obj.get('cells') or []
        cell_text = '\x1f'.join(
            normalize_text(cell, 'exact') for row in cells for cell in (row or ())
        )
        return (
            'table',
            len(cells),
            max((len(row or ()) for row in cells), default=0),
            round(width, 2),
            round(height, 2),
            hashlib.sha256(cell_text.encode('utf-8')).hexdigest(),
        )
    return (type_,)


def _table_details(
    old: Mapping[str, Any],
    new: Mapping[str, Any],
    options: DiffOptions,
) -> dict[str, Any]:
    """Cell-level table differences, leaving the extracted ``cells`` shape alone."""
    old_cells = old.get('cells') or []
    new_cells = new.get('cells') or []
    row_count = max(len(old_cells), len(new_cells))
    col_count = max(
        [len(row or ()) for row in old_cells] + [len(row or ()) for row in new_cells] + [0]
    )

    cell_changes = []
    for row_index in range(row_count):
        old_row = old_cells[row_index] if row_index < len(old_cells) else []
        new_row = new_cells[row_index] if row_index < len(new_cells) else []
        for col_index in range(col_count):
            old_text = old_row[col_index] if col_index < len(old_row or ()) else ''
            new_text = new_row[col_index] if col_index < len(new_row or ()) else ''
            old_text = '' if old_text is None else str(old_text)
            new_text = '' if new_text is None else str(new_text)
            if normalize_text(old_text, options.text_tolerance) != normalize_text(
                new_text, options.text_tolerance
            ):
                cell_changes.append(
                    {'row': row_index, 'col': col_index, 'old': old_text, 'new': new_text}
                )

    details: dict[str, Any] = {}
    if cell_changes:
        details['cellChanges'] = cell_changes
    if len(old_cells) != len(new_cells):
        details['rows'] = {'old': len(old_cells), 'new': len(new_cells)}
    old_cols = max((len(row or ()) for row in old_cells), default=0)
    new_cols = max((len(row or ()) for row in new_cells), default=0)
    if old_cols != new_cols:
        details['cols'] = {'old': old_cols, 'new': new_cols}
    return details


def _geometry_details(
    type_: str,
    old: Mapping[str, Any],
    new: Mapping[str, Any],
    options: DiffOptions,
) -> dict[str, Any]:
    details: dict[str, Any] = {}

    if type_ in ('rect', 'line'):
        if not options.ignore_colors:
            old_color = str(old.get('color') or '')
            new_color = str(new.get('color') or '')
            if old_color != new_color:
                details['color'] = {'old': old_color, 'new': new_color}
        if bool(old.get('stroke')) != bool(new.get('stroke')):
            details['stroke'] = {'old': bool(old.get('stroke')), 'new': bool(new.get('stroke'))}
        if type_ == 'rect' and bool(old.get('fill')) != bool(new.get('fill')):
            details['fill'] = {'old': bool(old.get('fill')), 'new': bool(new.get('fill'))}
        old_stroke_width = round(_number(old.get('width')), 3)
        new_stroke_width = round(_number(new.get('width')), 3)
        if old_stroke_width != new_stroke_width:
            details['strokeWidth'] = {'old': old_stroke_width, 'new': new_stroke_width}
        old_width, old_height = _size(old)
        new_width, new_height = _size(new)
        if round(old_width, 3) != round(new_width, 3) or round(old_height, 3) != round(
            new_height, 3
        ):
            details['size'] = {
                'old': {'width': round(old_width, 3), 'height': round(old_height, 3)},
                'new': {'width': round(new_width, 3), 'height': round(new_height, 3)},
            }
    elif type_ == 'curve':
        if bool(old.get('stroke')) != bool(new.get('stroke')):
            details['stroke'] = {'old': bool(old.get('stroke')), 'new': bool(new.get('stroke'))}
        old_points = _rounded_points(old.get('points'))
        new_points = _rounded_points(new.get('points'))
        if old_points != new_points:
            details['points'] = {'old': old_points, 'new': new_points}
    elif type_ == 'image':
        old_hash = old.get('content_hash')
        new_hash = new.get('content_hash')
        if isinstance(old_hash, str) and isinstance(new_hash, str) and old_hash and new_hash:
            if old_hash != new_hash:
                details['contentHash'] = {'old': old_hash, 'new': new_hash}
        else:
            # Without both hashes the bytes cannot be compared; fall back to the
            # pixel dimensions that the extractor reports.
            old_width = round(_number(old.get('width')), 3)
            old_height = round(_number(old.get('height')), 3)
            new_width = round(_number(new.get('width')), 3)
            new_height = round(_number(new.get('height')), 3)
            if (old_width, old_height) != (new_width, new_height):
                details['pixelSize'] = {
                    'old': {'width': old_width, 'height': old_height},
                    'new': {'width': new_width, 'height': new_height},
                }
    return details


# --- per-type object diffing ------------------------------------------------


def _is_ignored(type_: str, options: DiffOptions) -> bool:
    return type_ in options.ignore_types or (type_ == 'image' and options.ignore_images)


def _object_text(obj: Optional[Mapping[str, Any]]) -> Optional[str]:
    if obj is None:
        return None
    text = obj.get('text')
    return None if text is None else str(text)


def _diff_text_objects(
    type_: str,
    old_objects: Sequence[Mapping[str, Any]],
    new_objects: Sequence[Mapping[str, Any]],
    options: DiffOptions,
    old_page: int,
    new_page: int,
    limit: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Text-level changes for one object type.

    ``limit`` is the page's remaining change budget: once ``len(changes)``
    reaches it, no further change is built, which keeps a pathological page from
    allocating an unbounded list.  Matching itself still runs to completion.
    """
    tolerance = options.position_tolerance
    mode = options.text_tolerance
    include_color = type_ == 'char'

    pairs = _greedy(_near_candidates(old_objects, new_objects, tolerance, mode, anchored=True))
    used_old = {old_index for old_index, _ in pairs}
    used_new = {new_index for _, new_index in pairs}

    groups_old: dict[str, list[int]] = defaultdict(list)
    groups_new: dict[str, list[int]] = defaultdict(list)
    for index, obj in enumerate(old_objects):
        if index not in used_old:
            groups_old[normalize_text(obj.get('text', ''), mode)].append(index)
    for index, obj in enumerate(new_objects):
        if index not in used_new:
            groups_new[normalize_text(obj.get('text', ''), mode)].append(index)

    for key in sorted(groups_old.keys() & groups_new.keys()):
        pairs.extend(
            _pair_group(
                groups_old[key], groups_new[key], old_objects, new_objects, anchored=True
            )
        )

    matched_old = {old_index for old_index, _ in pairs}
    matched_new = {new_index for _, new_index in pairs}

    changes: list[dict[str, Any]] = []
    for old_index, new_index in pairs:
        if limit is not None and len(changes) >= limit:
            return changes
        old_obj = old_objects[old_index]
        new_obj = new_objects[new_index]
        details = _text_style_details(old_obj, new_obj, options, include_color)
        old_text = '' if old_obj.get('text') is None else str(old_obj.get('text'))
        new_text = '' if new_obj.get('text') is None else str(new_obj.get('text'))
        # Only words report relocation: character glyphs are matched for
        # text/style detail (the plan's contract), and a page-wide shift of
        # every glyph as "moved" would drown the report in noise.
        moved = (
            type_ == 'word'
            and old_text == new_text
            and _anchor_distance(old_obj, new_obj) > tolerance + 1e-9
        )
        text_changed = normalize_text(old_text, mode) != normalize_text(new_text, mode)
        if details or text_changed:
            kind = 'modified'
        elif moved:
            kind = 'moved'
        else:
            continue
        changes.append(
            _make_change(
                kind,
                type_,
                old_page,
                new_page,
                old_obj,
                new_obj,
                text_old=_object_text(old_obj),
                text_new=_object_text(new_obj),
                details=details,
            )
        )

    for index, obj in enumerate(old_objects):
        if index in matched_old:
            continue
        if limit is not None and len(changes) >= limit:
            return changes
        changes.append(
            _make_change(
                'removed',
                type_,
                old_page,
                None,
                old_obj=obj,
                text_old=_object_text(obj),
            )
        )
    for index, obj in enumerate(new_objects):
        if index in matched_new:
            continue
        if limit is not None and len(changes) >= limit:
            return changes
        changes.append(
            _make_change(
                'added',
                type_,
                None,
                new_page,
                new_obj=obj,
                text_new=_object_text(obj),
            )
        )
    return changes


def _diff_structural_objects(
    type_: str,
    old_objects: Sequence[Mapping[str, Any]],
    new_objects: Sequence[Mapping[str, Any]],
    options: DiffOptions,
    old_page: int,
    new_page: int,
    limit: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Match rect/line/curve/image/table objects by place and by signature.

    Positional closeness yields unchanged/modified objects; identical
    signatures (size/angle/point count/content hash/cells) pair the leftovers so
    a relocated object is reported as moved instead of removed+added.

    ``limit`` is the page's remaining change budget; matching still runs to
    completion, only the change list stops growing.
    """
    tolerance = options.position_tolerance

    pairs = _greedy(_near_candidates(old_objects, new_objects, tolerance))
    used_old = {old_index for old_index, _ in pairs}
    used_new = {new_index for _, new_index in pairs}

    groups_old: dict[tuple, list[int]] = defaultdict(list)
    groups_new: dict[tuple, list[int]] = defaultdict(list)
    for index, obj in enumerate(old_objects):
        if index not in used_old:
            groups_old[_geometry_signature(type_, obj)].append(index)
    for index, obj in enumerate(new_objects):
        if index not in used_new:
            groups_new[_geometry_signature(type_, obj)].append(index)

    # ``repr`` ordering keeps the traversal deterministic even when a page has
    # signatures of different shapes (an image with and without a content hash).
    for key in sorted(groups_old.keys() & groups_new.keys(), key=repr):
        pairs.extend(_pair_group(groups_old[key], groups_new[key], old_objects, new_objects))

    matched_old = {old_index for old_index, _ in pairs}
    matched_new = {new_index for _, new_index in pairs}

    changes: list[dict[str, Any]] = []
    for old_index, new_index in pairs:
        if limit is not None and len(changes) >= limit:
            return changes
        old_obj = old_objects[old_index]
        new_obj = new_objects[new_index]
        if type_ == 'table':
            details = _table_details(old_obj, new_obj, options)
        else:
            details = _geometry_details(type_, old_obj, new_obj, options)
        moved = _center_distance(old_obj, new_obj) > tolerance + 1e-9
        if details:
            kind = 'modified'
        elif moved:
            kind = 'moved'
        else:
            continue
        changes.append(
            _make_change(kind, type_, old_page, new_page, old_obj, new_obj, details=details)
        )

    for index, obj in enumerate(old_objects):
        if index in matched_old:
            continue
        if limit is not None and len(changes) >= limit:
            return changes
        changes.append(_make_change('removed', type_, old_page, None, old_obj=obj))
    for index, obj in enumerate(new_objects):
        if index in matched_new:
            continue
        if limit is not None and len(changes) >= limit:
            return changes
        changes.append(_make_change('added', type_, None, new_page, new_obj=obj))
    return changes


def _page_objects(page: Mapping[str, Any], type_: str) -> list[Mapping[str, Any]]:
    objects = page.get(_PAGE_KEYS[type_]) or []
    return list(objects)


def _page_media_box(page: Mapping[str, Any]) -> dict[str, float]:
    boxes = page.get('boxes')
    if isinstance(boxes, Mapping):
        media = boxes.get('media')
        if isinstance(media, Mapping):
            return {
                'x0': _number(media.get('x0')),
                'y0': _number(media.get('y0')),
                'x1': _number(media.get('x1')),
                'y1': _number(media.get('y1')),
            }
    return {
        'x0': 0.0,
        'y0': 0.0,
        'x1': _number(page.get('width')),
        'y1': _number(page.get('height')),
    }


def _page_geometry_change(
    old_page: Mapping[str, Any],
    new_page: Mapping[str, Any],
    old_page_num: int,
    new_page_num: int,
) -> Optional[dict[str, Any]]:
    """Page size/rotation differences as one explicit change entry.

    ``DiffChange.type`` is restricted to object types, so the page-level change
    is reported as a ``rect`` modification whose ``details.pageGeometry`` marks
    it as page geometry rather than a real rectangle.
    """
    old_width = _number(old_page.get('width'))
    old_height = _number(old_page.get('height'))
    new_width = _number(new_page.get('width'))
    new_height = _number(new_page.get('height'))
    old_rotation = int(_number(old_page.get('rotation'))) % 360
    new_rotation = int(_number(new_page.get('rotation'))) % 360

    size_changed = (round(old_width, 3), round(old_height, 3)) != (
        round(new_width, 3),
        round(new_height, 3),
    )
    rotation_changed = old_rotation != new_rotation
    if not size_changed and not rotation_changed:
        return None

    details: dict[str, Any] = {}
    if size_changed:
        details['size'] = {
            'old': {'width': old_width, 'height': old_height},
            'new': {'width': new_width, 'height': new_height},
        }
    if rotation_changed:
        details['rotation'] = {'old': old_rotation, 'new': new_rotation}

    return _make_change(
        'modified',
        'rect',
        old_page_num,
        new_page_num,
        old_obj=_page_media_box(old_page),
        new_obj=_page_media_box(new_page),
        details={'pageGeometry': details},
    )


# --- resource comparison (annotations, links, forms, metadata, page labels) --


def _resource_ignored(kind: str, options: DiffOptions) -> bool:
    return bool(getattr(options, _RESOURCE_IGNORE_ATTRS[kind], False))


def page_resource_comparison_enabled(options: DiffOptions) -> bool:
    """True when at least one page-level resource kind is compared."""
    return not all(_resource_ignored(kind, options) for kind in RESOURCE_TYPES)


def document_resource_comparison_enabled(options: DiffOptions) -> bool:
    """True when metadata or page labels are compared."""
    return not (options.ignore_metadata and options.ignore_page_labels)


def resource_comparison_enabled(options: DiffOptions) -> bool:
    """True when the run has to collect resources at all."""
    return page_resource_comparison_enabled(options) or document_resource_comparison_enabled(
        options
    )


# Collector cap/skip reason -> the ``DiffOptions`` switch whose kind it degrades.
# ``destinations`` resolves internal link targets, and ``pages`` means a whole
# page's annotation/link/form blocks failed to parse (any compared kind suffers).
_RESOURCE_INCOMPLETE_ATTRS = {
    'annotations': 'ignore_annotations',
    'annotationsPerPage': 'ignore_annotations',
    'links': 'ignore_links',
    'destinations': 'ignore_links',
    'forms': 'ignore_forms',
    'formFields': 'ignore_forms',
    'formOptions': 'ignore_forms',
    'metadata': 'ignore_metadata',
    'pageLabels': 'ignore_page_labels',
}


def resource_comparison_incomplete(
    old_resources: Optional[Mapping[str, Any]],
    new_resources: Optional[Mapping[str, Any]],
    options: DiffOptions,
) -> bool:
    """True when a *compared* resource kind was capped or could not be read.

    The collector records per-block ``truncated``/``skipped`` counts instead of
    failing (a 600-annotation page must not abort the diff).  Those notes still
    make the result incomplete, so the engine flags truncation exactly like the
    ``MAX_DIFF_CHANGES`` cap: a capped or skipped block never reports a clean
    "no changes" for the kind that was being compared.  Notes about a kind that
    the options skipped are ignored: its result is intentionally absent.
    """
    if not resource_comparison_enabled(options):
        return False
    pages_compared = page_resource_comparison_enabled(options)
    for resources in (old_resources, new_resources):
        if not resources:
            continue
        for bucket in ('truncated', 'skipped'):
            counts = resources.get(bucket) or {}
            if not isinstance(counts, Mapping):
                continue
            for key, value in counts.items():
                try:
                    if int(value or 0) <= 0:
                        continue
                except (TypeError, ValueError):
                    continue
                if key == 'pages':
                    if pages_compared:
                        return True
                    continue
                attr = _RESOURCE_INCOMPLETE_ATTRS.get(str(key))
                if attr is None:
                    # Unknown reason from a newer collector: stay conservative and
                    # never claim the run was complete.
                    return True
                if not bool(getattr(options, attr, False)):
                    return True
    return False


def _page_resources_at(
    resources: Optional[Mapping[str, Any]],
    index: Optional[int],
) -> Optional[dict[str, Any]]:
    """The collector entry of one 1-based page, or ``None`` when unavailable.

    ``None`` means "this side has no resource data" (resources were not
    collected, or the page does not exist on that side), which is exactly what
    the one-sided resource comparison expects.
    """
    if not resources or index is None:
        return None
    pages = resources.get('pages') or ()
    if 1 <= index <= len(pages):
        entry = pages[index - 1]
        if isinstance(entry, Mapping):
            return dict(entry)
    return None


def _page_resource_digest(
    page_resources: Mapping[str, Any],
    options: DiffOptions,
) -> str:
    """Digest of the *compared* resource kinds of one page.

    Ignored kinds are hashed as empty lists, so turning a kind off also removes
    it from the page fast path: a page whose only difference is an ignored kind
    stays "unchanged" instead of being compared and reported as changed with no
    changes.
    """
    comparable = {
        _PAGE_RESOURCE_KEYS[kind]: (
            []
            if _resource_ignored(kind, options)
            else [
                entry
                for entry in page_resources.get(_PAGE_RESOURCE_KEYS[kind]) or ()
                if isinstance(entry, Mapping)
            ]
        )
        for kind in RESOURCE_TYPES
    }
    return page_resource_digest(comparable)


def _digest_at(digests: Optional[Sequence[str]], index: Optional[int]) -> Optional[str]:
    if digests is None or index is None or not 1 <= index <= len(digests):
        return None
    return digests[index - 1]


def _resource_text(kind: str, entry: Optional[Mapping[str, Any]]) -> Optional[str]:
    """The text a resource change reports in ``textOld``/``textNew``."""
    if not entry:
        return None
    if kind == 'link':
        value = entry.get('target') or entry.get('uri')
    else:
        value = entry.get(_RESOURCE_TEXT_FIELDS[kind])
    return None if value is None else str(value)


def _identity_embeds_rect(identity: str) -> bool:
    """True when the R1 identity already contains the rect.

    ``/NM`` identities (``ann:nm:…``, ``link:nm:…``) do not embed the rect, so a
    matched entry can be reported as *moved*.  Every other identity (including
    every form identity) embeds the rect, which means moving such a resource
    changes its identity: the diff then reports one removed and one added entry
    instead of a move.  That is a documented limitation, not a bug: inventing a
    positional fallback would risk merging unrelated resources.
    """
    return '|rect=' in identity or identity.startswith(('link:rect:', 'form:rect:'))


def _resource_details(
    kind: str,
    identity: str,
    old_entry: Optional[Mapping[str, Any]],
    new_entry: Optional[Mapping[str, Any]],
) -> dict[str, Any]:
    """``details`` of one resource change: kind, identity and old/new fields.

    Every difference is reported as an ``{'old', 'new'}`` pair (a one-sided
    entry pairs its values with ``None``), so the UI renders one table for added,
    removed, moved and modified resources alike.
    """
    details: dict[str, Any] = {'resource': kind, 'identity': identity}
    for field in _RESOURCE_FIELDS[kind]:
        old_value = None if old_entry is None else old_entry.get(field)
        new_value = None if new_entry is None else new_entry.get(field)
        if old_value != new_value:
            details[field] = {'old': old_value, 'new': new_value}
    old_rect = None if old_entry is None else old_entry.get('rect')
    new_rect = None if new_entry is None else new_entry.get('rect')
    if old_rect != new_rect:
        details['rect'] = {'old': old_rect, 'new': new_rect}
    return details


def _resource_change(
    kind: str,
    identity: str,
    old_entry: Optional[Mapping[str, Any]],
    new_entry: Optional[Mapping[str, Any]],
    old_page: Optional[int],
    new_page: Optional[int],
) -> Optional[dict[str, Any]]:
    """One page-level resource change, or ``None`` when nothing differs."""
    details = _resource_details(kind, identity, old_entry, new_entry)
    field_changes = any(
        key not in ('resource', 'identity', 'rect') for key in details
    )
    rect_changed = 'rect' in details

    if old_entry is None:
        change_kind = 'added'
    elif new_entry is None:
        change_kind = 'removed'
    elif field_changes:
        change_kind = 'modified'
    elif rect_changed and not _identity_embeds_rect(identity):
        change_kind = 'moved'
    elif rect_changed:
        # Only reachable when two identities collide at the identity's rounding
        # precision: report it as a modification, never as a move.
        change_kind = 'modified'
    else:
        return None

    return _make_change(
        change_kind,
        kind,
        old_page,
        new_page,
        # A resource entry keeps its box under ``rect``; ``_make_change`` wants
        # the box itself so ``oldBBox``/``newBBox`` stay the contract's shape.
        None if old_entry is None else old_entry.get('rect'),
        None if new_entry is None else new_entry.get('rect'),
        text_old=_resource_text(kind, old_entry),
        text_new=_resource_text(kind, new_entry),
        details=details,
    )


def _resource_changes(
    kind: str,
    old_entries: Iterable[Mapping[str, Any]],
    new_entries: Iterable[Mapping[str, Any]],
    old_page: Optional[int],
    new_page: Optional[int],
    limit: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Pair one resource kind by R1 identity and report the differences.

    Identities are unique per page (the collector suffixes collisions), so
    pairing is a dictionary lookup.  Identities are visited in sorted order and
    the change list is sorted again by :func:`_change_sort_key`, so the output
    never depends on dictionary order.
    """
    old_by_identity = {
        str(entry['identity']): entry
        for entry in old_entries or ()
        if isinstance(entry, Mapping) and entry.get('identity')
    }
    new_by_identity = {
        str(entry['identity']): entry
        for entry in new_entries or ()
        if isinstance(entry, Mapping) and entry.get('identity')
    }

    changes: list[dict[str, Any]] = []
    for identity in sorted(set(old_by_identity) | set(new_by_identity)):
        if limit is not None and len(changes) >= limit:
            break
        change = _resource_change(
            kind,
            identity,
            old_by_identity.get(identity),
            new_by_identity.get(identity),
            old_page,
            new_page,
        )
        if change is not None:
            changes.append(change)
    return changes


def _page_resource_changes(
    old_resources: Optional[Mapping[str, Any]],
    new_resources: Optional[Mapping[str, Any]],
    options: DiffOptions,
    old_page: Optional[int],
    new_page: Optional[int],
    limit: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Every annotation/link/form change of one aligned page pair.

    A one-sided page passes ``None`` for the missing side, which turns all of its
    resources into added/removed entries.  ``limit`` is the page's remaining
    change budget, exactly like the object loops.
    """
    changes: list[dict[str, Any]] = []
    for kind in RESOURCE_TYPES:
        if _resource_ignored(kind, options):
            continue
        remaining = None if limit is None else max(0, limit - len(changes))
        if remaining == 0:
            break
        changes.extend(
            _resource_changes(
                kind,
                (old_resources or {}).get(_PAGE_RESOURCE_KEYS[kind]) or (),
                (new_resources or {}).get(_PAGE_RESOURCE_KEYS[kind]) or (),
                old_page,
                new_page,
                limit=remaining,
            )
        )
    return changes


def _metadata_value(metadata: Optional[Mapping[str, Any]], field: str) -> Optional[str]:
    if not metadata:
        return None
    value = metadata.get(field)
    return None if value is None else str(value)


def _document_change(
    kind: str,
    type_: str,
    page: Optional[int],
    field: str,
    old_value: Optional[str],
    new_value: Optional[str],
    details: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    return {
        'kind': kind,
        'type': type_,
        'page': page,
        'field': field,
        'oldValue': old_value,
        'newValue': new_value,
        'details': details or {},
    }


def _value_kind(old_value: Optional[str], new_value: Optional[str]) -> str:
    if old_value is None:
        return 'added'
    if new_value is None:
        return 'removed'
    return 'modified'


def _metadata_changes(
    old_metadata: Optional[Mapping[str, Any]],
    new_metadata: Optional[Mapping[str, Any]],
    options: DiffOptions,
) -> list[dict[str, Any]]:
    """Info dictionary/catalog language differences, one entry per field."""
    if options.ignore_metadata:
        return []
    changes: list[dict[str, Any]] = []
    for field in METADATA_FIELDS:
        old_value = _metadata_value(old_metadata, field)
        new_value = _metadata_value(new_metadata, field)
        if old_value == new_value:
            continue
        changes.append(
            _document_change(
                _value_kind(old_value, new_value), 'metadata', None, field, old_value, new_value
            )
        )
    return changes


def _page_label_changes(
    old_labels: Iterable[Mapping[str, Any]],
    new_labels: Iterable[Mapping[str, Any]],
    options: DiffOptions,
) -> list[dict[str, Any]]:
    """Page label differences; ``page`` is the 1-based PDF page number."""
    if options.ignore_page_labels:
        return []
    old_by_page = {
        int(label['page']): label
        for label in old_labels or ()
        if isinstance(label, Mapping) and isinstance(label.get('page'), int)
    }
    new_by_page = {
        int(label['page']): label
        for label in new_labels or ()
        if isinstance(label, Mapping) and isinstance(label.get('page'), int)
    }

    changes: list[dict[str, Any]] = []
    for page in sorted(set(old_by_page) | set(new_by_page)):
        old_entry = old_by_page.get(page)
        new_entry = new_by_page.get(page)
        old_value = None if old_entry is None else old_entry.get('label')
        new_value = None if new_entry is None else new_entry.get('label')
        details: dict[str, Any] = {}
        for field in _PAGE_LABEL_FIELDS:
            old_field = None if old_entry is None else old_entry.get(field)
            new_field = None if new_entry is None else new_entry.get(field)
            if old_field != new_field:
                details[field] = {'old': old_field, 'new': new_field}
        if old_value == new_value and not details:
            continue
        changes.append(
            _document_change(
                _value_kind(old_value, new_value),
                'page-label',
                page,
                'page-label',
                None if old_value is None else str(old_value),
                None if new_value is None else str(new_value),
                details,
            )
        )
    return changes


def _document_change_sort_key(change: Mapping[str, Any]) -> tuple:
    """Metadata first (field order), then page labels by page number."""
    type_ = str(change.get('type') or '')
    field = str(change.get('field') or '')
    if type_ == 'metadata':
        page_key: float = -1.0
        field_key = _METADATA_FIELD_ORDER.get(field, len(METADATA_FIELDS))
    else:
        page_key = _number(change.get('page'), 0.0)
        field_key = 0
    return (
        _DOCUMENT_TYPE_ORDER.get(type_, len(DOCUMENT_CHANGE_TYPES)),
        page_key,
        field_key,
        field,
        _KIND_ORDER.get(change.get('kind'), 9),
        change.get('oldValue') or '',
        change.get('newValue') or '',
        json.dumps(change.get('details') or {}, sort_keys=True, ensure_ascii=False),
    )


def _document_changes(
    old_resources: Optional[Mapping[str, Any]],
    new_resources: Optional[Mapping[str, Any]],
    options: DiffOptions,
) -> list[dict[str, Any]]:
    """Metadata and page-label changes, sorted deterministically.

    Document changes are never affected by ignore regions (they carry no box)
    and never enter a page's ``changes`` list, so a metadata-only edit does not
    mark every page changed.
    """
    if old_resources is None or new_resources is None:
        return []
    changes = _metadata_changes(
        old_resources.get('metadata'), new_resources.get('metadata'), options
    )
    changes.extend(
        _page_label_changes(
            old_resources.get('pageLabels') or (),
            new_resources.get('pageLabels') or (),
            options,
        )
    )
    return sorted(changes, key=_document_change_sort_key)


def _diff_pair_changes(
    old_page: Mapping[str, Any],
    new_page: Mapping[str, Any],
    options: DiffOptions,
    old_index: int,
    new_index: int,
    include_page_geometry: bool = True,
    max_changes: Optional[int] = None,
    old_resources: Optional[Mapping[str, Any]] = None,
    new_resources: Optional[Mapping[str, Any]] = None,
) -> tuple[list[dict[str, Any]], bool]:
    """:func:`diff_pages` plus whether the change list was truncated.

    ``max_changes`` is the number of changes this page may contribute; one more
    than the budget is built so truncation is detectable without a second pass,
    then the sorted list is sliced.  Matching always runs to completion, so the
    kept changes are the same ones an uncapped run would report first.

    ``old_resources``/``new_resources`` are the collector entries of the two
    pages.  Their changes join the same list (and the same budget) as object
    changes, so page grouping, region masking, sorting and the cap behave
    exactly as they do for objects.
    """
    changes: list[dict[str, Any]] = []
    if include_page_geometry:
        geometry_change = _page_geometry_change(old_page, new_page, old_index, new_index)
        if geometry_change is not None:
            changes.append(geometry_change)

    # Build one change beyond the budget: that is what tells us the page had
    # more to report than it was allowed to keep.
    limit = None if max_changes is None else max(max_changes, 0) + 1

    for type_ in DIFF_TYPES:
        if _is_ignored(type_, options):
            continue
        if limit is not None and len(changes) >= limit:
            break
        old_objects = _page_objects(old_page, type_)
        new_objects = _page_objects(new_page, type_)
        if not old_objects and not new_objects:
            continue
        remaining = None if limit is None else max(0, limit - len(changes))
        if type_ in TEXT_TYPES:
            changes.extend(
                _diff_text_objects(
                    type_,
                    old_objects,
                    new_objects,
                    options,
                    old_index,
                    new_index,
                    limit=remaining,
                )
            )
        else:
            changes.extend(
                _diff_structural_objects(
                    type_,
                    old_objects,
                    new_objects,
                    options,
                    old_index,
                    new_index,
                    limit=remaining,
                )
            )

    if old_resources is not None or new_resources is not None:
        remaining = None if limit is None else max(0, limit - len(changes))
        if remaining is None or remaining > 0:
            changes.extend(
                _page_resource_changes(
                    old_resources,
                    new_resources,
                    options,
                    old_index,
                    new_index,
                    limit=remaining,
                )
            )
    # Region masking runs on the matched changes, immediately before sorting:
    # the object pairing never sees the regions, so removing a region restores
    # exactly the changes it hid.  Resource changes with a BBox are masked the
    # same way; metadata/page labels are document-level and never reach here.
    sorted_changes = _sort_changes(_without_ignored_changes(changes, options))
    truncated = max_changes is not None and len(sorted_changes) > max_changes
    if truncated:
        sorted_changes = sorted_changes[:max_changes]
    return sorted_changes, truncated


def diff_pages(
    old_page: Mapping[str, Any],
    new_page: Mapping[str, Any],
    options: Optional[DiffOptions] = None,
    old_index: int = 1,
    new_index: int = 1,
    include_page_geometry: bool = True,
    max_changes: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Diff two extracted pages and return the sorted change list.

    Exposed for unit tests and for consumers that already hold page data; the
    page objects are the dicts returned by ``PdfExtractor.extract_page``.

    ``max_changes`` caps the returned list (see :data:`MAX_DIFF_CHANGES`); the
    truncated flag is exposed through :func:`_diff_pair_changes` for
    :func:`diff_files`.
    """
    opts = options if options is not None else DiffOptions()
    if not isinstance(opts, DiffOptions):
        raise TypeError('options must be a DiffOptions instance')

    changes, _truncated = _diff_pair_changes(
        old_page,
        new_page,
        opts,
        old_index,
        new_index,
        include_page_geometry=include_page_geometry,
        max_changes=max_changes,
    )
    return changes


def _one_sided_changes(
    page: Mapping[str, Any],
    page_num: int,
    kind: str,
    options: DiffOptions,
    max_changes: Optional[int] = None,
    resources: Optional[Mapping[str, Any]] = None,
) -> tuple[list[dict[str, Any]], bool]:
    """Every object of an added/removed page becomes one added/removed change.

    ``max_changes`` is the run's remaining change budget, so a large inserted
    page cannot push the result past :data:`MAX_DIFF_CHANGES` either.  Returns
    ``(changes, truncated)`` like :func:`_diff_pair_changes`.

    ``resources`` is the collector entry of the page: its annotations, links and
    form widgets become added/removed resource changes alongside the objects.
    """
    changes: list[dict[str, Any]] = []
    # See _diff_pair_changes: building one extra change makes truncation visible.
    limit = None if max_changes is None else max(max_changes, 0) + 1
    for type_ in DIFF_TYPES:
        if _is_ignored(type_, options):
            continue
        for obj in _page_objects(page, type_):
            if limit is not None and len(changes) >= limit:
                break
            if kind == 'added':
                changes.append(
                    _make_change(
                        'added',
                        type_,
                        None,
                        page_num,
                        new_obj=obj,
                        text_new=_object_text(obj),
                    )
                )
            else:
                changes.append(
                    _make_change(
                        'removed',
                        type_,
                        page_num,
                        None,
                        old_obj=obj,
                        text_old=_object_text(obj),
                    )
                )
        if limit is not None and len(changes) >= limit:
            break
    if resources is not None:
        remaining = None if limit is None else max(0, limit - len(changes))
        if remaining is None or remaining > 0:
            changes.extend(
                _page_resource_changes(
                    resources if kind == 'removed' else None,
                    resources if kind == 'added' else None,
                    options,
                    page_num if kind == 'removed' else None,
                    page_num if kind == 'added' else None,
                    limit=remaining,
                )
            )
    # A one-sided page only has one side's changes, so only that side's regions
    # can mask them (the other page number is null on every change).
    sorted_changes = _sort_changes(_without_ignored_changes(changes, options))
    truncated = max_changes is not None and len(sorted_changes) > max_changes
    if truncated:
        sorted_changes = sorted_changes[:max_changes]
    return sorted_changes, truncated


# --- file level API ---------------------------------------------------------


def tool_version() -> str:
    """Read the tool version from ``package.json`` (``0.0.0`` if unavailable)."""
    try:
        data = json.loads(_PACKAGE_JSON.read_text(encoding='utf-8'))
    except Exception:
        return '0.0.0'
    version = data.get('version') if isinstance(data, Mapping) else None
    return version if isinstance(version, str) and version else '0.0.0'


def options_to_dict(options: DiffOptions) -> dict[str, Any]:
    """Serialise options with the contract's camelCase keys.

    ``ignoreRegions`` is echoed normalized (ordered boxes, integer page
    numbers), so a JSON consumer can reproduce the mask that was applied. Every
    boolean switch is echoed explicitly (never omitted), including the resource
    switches, so a report shows that metadata/page labels were compared or
    skipped. The resource keys are additive: older consumers ignore them.
    """
    ignored = set(options.ignore_types)
    return {
        'positionTolerance': float(options.position_tolerance),
        'textTolerance': options.text_tolerance,
        'ignoreTypes': [type_ for type_ in DIFF_TYPES if type_ in ignored],
        'ignoreFonts': bool(options.ignore_fonts),
        'ignoreColors': bool(options.ignore_colors),
        'ignoreImages': bool(options.ignore_images),
        'ignoreAnnotations': bool(options.ignore_annotations),
        'ignoreLinks': bool(options.ignore_links),
        'ignoreForms': bool(options.ignore_forms),
        'ignoreMetadata': bool(options.ignore_metadata),
        'ignorePageLabels': bool(options.ignore_page_labels),
        'ignoreRegions': [
            {
                'oldPage': region['oldPage'],
                'newPage': region['newPage'],
                'bbox': dict(region['bbox']),
            }
            for region in options.ignore_regions
        ],
    }


def _sha256_file(path: Path, label: str) -> str:
    digest = hashlib.sha256()
    try:
        with path.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError as exc:
        raise DiffError(f'Cannot read {label} PDF {str(path)!r}: {exc}') from exc
    return digest.hexdigest()


def _open_extractor(path: Path, label: str) -> PdfExtractor:
    try:
        return PdfExtractor(str(path))
    except Exception as exc:
        raise DiffError(f'Cannot open {label} PDF {str(path)!r}: {exc}') from exc


def _page_count(extractor: PdfExtractor, path: Path, label: str) -> int:
    try:
        return len(extractor._pdf.pages)
    except Exception as exc:
        raise DiffError(f'Cannot read pages of {label} PDF {str(path)!r}: {exc}') from exc


def _release_page_layout(extractor: PdfExtractor, page_num: int) -> None:
    """Drop pdfplumber's per-page layout cache once a page has been consumed.

    ``PdfExtractor.extract_page`` triggers pdfplumber's cached char/rect/line
    analysis; without flushing it, diffing two long documents would keep every
    page's objects alive.  Best effort: older pdfplumber builds simply keep the
    cache.
    """
    try:
        page = extractor._pdf.pages[page_num - 1]
        flush = getattr(page, 'flush_cache', None)
        if callable(flush):
            flush()
    except Exception:
        pass


def _diff_include_types(options: DiffOptions) -> set[str]:
    """Object types the diff pass must extract for these options.

    Everything except the ignored types: ``ignore_images`` is the option-shaped
    equivalent of adding ``"image"`` to ``ignore_types``, so it is folded in
    here and both surfaces reach the extractor as one include set.
    """
    included = set(DIFF_TYPES) - set(options.ignore_types)
    if options.ignore_images:
        included.discard('image')
    return included


def _extract_page(
    extractor: PdfExtractor,
    page_num: int,
    path: Path,
    label: str,
    include_types: Optional[Iterable[str]] = None,
) -> dict:
    try:
        page_data = extractor.extract_page(page_num, include_types=include_types)
    except Exception as exc:
        raise DiffError(
            f'Cannot extract page {page_num} of {label} PDF {str(path)!r}: {exc}'
        ) from exc
    finally:
        _release_page_layout(extractor, page_num)
    return page_data


def _close_extractor(extractor: Optional[PdfExtractor]) -> None:
    if extractor is None:
        return
    try:
        extractor.close()
    except Exception:
        # Closing is best effort: never mask the real diff result or error.
        pass


def _emit_progress(
    progress: Optional[Callable[[dict[str, Any]], None]],
    payload: dict[str, Any],
) -> None:
    """Report one progress payload, if the caller asked for progress.

    Payloads are deterministic (stage names plus counters) and never touch the
    result: a listener can drive a UI or an inactivity timeout without changing
    what :func:`diff_files` returns.
    """
    if progress is not None:
        progress(payload)


def _page_still_differs(
    old_fingerprints: Sequence[Any],
    new_fingerprints: Sequence[Any],
    old_index: Optional[int],
    new_index: Optional[int],
) -> bool:
    """True when an uncompared page probably holds changes.

    Used only after the change budget is spent: a one-sided page always has
    objects to report, and a paired page whose fingerprints differ is not
    identical.  Fingerprints are signature-derived, so equal fingerprints mean
    equal page content.
    """
    if old_index is None or new_index is None:
        return True
    return old_fingerprints[old_index - 1] != new_fingerprints[new_index - 1]


def diff_files(
    old_path: str | Path,
    new_path: str | Path,
    options: Optional[DiffOptions] = None,
    progress: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict[str, Any]:
    """Diff two PDF files and return a JSON-serialisable ``DiffResult``.

    Two passes, both page-at-a-time so memory stays flat:

    1. a *signature* pass (:func:`_page_signature`) hashes each page's geometry,
       content streams and resources straight from pdfminer objects — no layout,
       no extraction — and reports the page size with it;
    2. a *diff* pass that extracts a page pair **only when their signatures
       differ**.  An unchanged pair is reported from the signature alone
       (``status: "unchanged"``, ``match.score: 1.0``), so a page that did not
       change never pays for pdfplumber layout or object extraction.

    Byte-identical files short-circuit: the signature pass runs once and every
    page is reported unchanged.

    Both extractors are closed whether the diff succeeds or fails.

    ``progress`` (optional) is called with a deterministic payload as the work
    advances: ``start`` (page counts), one ``fingerprints`` report per page and
    side, one ``pages`` report per paired page and a final ``done`` summary.
    Transport layers use it to keep a long diff from looking like a hang; the
    returned dict is identical whether or not a callback is passed.

    At most :data:`MAX_DIFF_CHANGES` changes are kept across the whole run; once
    the budget is spent the remaining pages are still reported (with their
    sizes and status), but they contribute no changes and the result carries
    ``truncated: true`` plus ``summary.changesTruncated: true``.
    """
    opts = options if options is not None else DiffOptions()
    if not isinstance(opts, DiffOptions):
        raise TypeError('options must be a DiffOptions instance')

    old_file = Path(old_path)
    new_file = Path(new_path)

    old_sha256 = _sha256_file(old_file, 'old')
    new_sha256 = _sha256_file(new_file, 'new')

    old_extractor: Optional[PdfExtractor] = None
    new_extractor: Optional[PdfExtractor] = None
    try:
        old_extractor = _open_extractor(old_file, 'old')
        new_extractor = _open_extractor(new_file, 'new')

        old_page_count = _page_count(old_extractor, old_file, 'old')
        new_page_count = _page_count(new_extractor, new_file, 'new')

        _emit_progress(
            progress,
            {'stage': 'start', 'oldPages': old_page_count, 'newPages': new_page_count},
        )

        # Byte-identical files cannot have differing pages: hash one side and
        # reuse the signatures (and sizes) for the other.
        identical_files = (
            old_sha256 == new_sha256 and old_page_count == new_page_count
        )

        old_signatures: list[tuple[str, float, float]] = []
        old_alignment: list[Any] = []
        for page_num in range(1, old_page_count + 1):
            old_signatures.append(
                _page_signature(old_extractor, page_num, old_file, 'old')
                if not identical_files
                else _identical_file_signature(old_extractor, page_num, old_file, 'old')
            )
            # Identical bytes need no alignment keys: the pairing is the ordinal.
            old_alignment.append(
                None
                if identical_files
                else _page_alignment_key(old_extractor, page_num, old_file, 'old')
            )
            _emit_progress(
                progress,
                {
                    'stage': 'fingerprints',
                    'side': 'old',
                    'done': page_num,
                    'total': old_page_count,
                },
            )

        if identical_files:
            new_signatures = old_signatures
            new_alignment = old_alignment
            for page_num in range(1, new_page_count + 1):
                _emit_progress(
                    progress,
                    {
                        'stage': 'fingerprints',
                        'side': 'new',
                        'done': page_num,
                        'total': new_page_count,
                    },
                )
        else:
            new_signatures = []
            new_alignment = []
            for page_num in range(1, new_page_count + 1):
                new_signatures.append(
                    _page_signature(new_extractor, page_num, new_file, 'new')
                )
                new_alignment.append(
                    _page_alignment_key(new_extractor, page_num, new_file, 'new')
                )
                _emit_progress(
                    progress,
                    {
                        'stage': 'fingerprints',
                        'side': 'new',
                        'done': page_num,
                        'total': new_page_count,
                    },
                )

        old_fingerprints = [_signature_fingerprint(sig) for sig in old_signatures]
        new_fingerprints = (
            old_fingerprints
            if identical_files
            else [_signature_fingerprint(sig) for sig in new_signatures]
        )

        if identical_files:
            # Same bytes, same order: the pairing is known without the matcher.
            pairs: list[tuple[Optional[int], Optional[int]]] = [
                (page_num, page_num) for page_num in range(1, old_page_count + 1)
            ]
        else:
            # Alignment runs on the coarse keys, so a page that moved (or moved
            # and changed) is still paired; the signature then decides whether
            # the pair is actually identical.
            pairs = pair_pages(old_alignment, new_alignment)
        _emit_progress(progress, {'stage': 'pages', 'done': 0, 'total': len(pairs)})

        include_types = _diff_include_types(opts)
        budget = MAX_DIFF_CHANGES
        truncated = False

        # Resources are collected once per side, and only when the options ask
        # for them.  Byte-identical files cannot differ, so they skip collection
        # entirely (the same shortcut the signature pass takes).
        resource_comparison = resource_comparison_enabled(opts) and not identical_files
        old_resources: Optional[dict[str, Any]] = (
            collect_document_resources(old_extractor) if resource_comparison else None
        )
        new_resources: Optional[dict[str, Any]] = (
            collect_document_resources(new_extractor) if resource_comparison else None
        )
        # A capped or unreadable resource block makes the result incomplete for
        # the kinds that were compared.  Report it through the same truncation
        # flag as the MAX_DIFF_CHANGES cap instead of claiming a clean run.
        resources_truncated = resource_comparison_incomplete(
            old_resources, new_resources, opts
        )
        if resources_truncated:
            truncated = True
        # Page resource digests join the page fast path: two pages are only
        # "unchanged" when their objects *and* their compared resources match.
        page_resources_compared = resource_comparison and page_resource_comparison_enabled(opts)
        old_resource_digests: Optional[list[str]] = (
            [_page_resource_digest(page, opts) for page in old_resources.get('pages') or ()]
            if page_resources_compared and old_resources is not None
            else None
        )
        new_resource_digests: Optional[list[str]] = (
            [_page_resource_digest(page, opts) for page in new_resources.get('pages') or ()]
            if page_resources_compared and new_resources is not None
            else None
        )

        pages: list[dict[str, Any]] = []
        for index, (old_index, new_index) in enumerate(pairs):
            if old_index is None and new_index is None:  # pragma: no cover - defensive
                _emit_progress(
                    progress, {'stage': 'pages', 'done': index + 1, 'total': len(pairs)}
                )
                continue
            # Once the change budget is spent, the remaining pages only need
            # their geometry: sizes and status stay correct without building
            # object lists that could never be reported.
            budget_spent = budget <= 0
            page_types = include_types if not budget_spent else frozenset()
            # The fast path: equal signatures *and* equal resources mean equal
            # pages, so there is nothing to extract and nothing to compare.
            signatures_equal = (
                old_index is not None
                and new_index is not None
                and old_signatures[old_index - 1][0] == new_signatures[new_index - 1][0]
            )
            resources_equal = True
            if signatures_equal:
                resources_equal = _digest_at(old_resource_digests, old_index) == _digest_at(
                    new_resource_digests, new_index
                )
            unchanged_pair = signatures_equal and resources_equal
            # Same objects, different annotations/links/form fields: the page is
            # not unchanged, but it does not need an object extraction either.
            resource_only_pair = signatures_equal and not resources_equal

            old_page_resources = _page_resources_at(old_resources, old_index)
            new_page_resources = _page_resources_at(new_resources, new_index)

            if old_index is None:
                page = _extract_page(
                    new_extractor, new_index, new_file, 'new', page_types
                )
                changes, page_truncated = _one_sided_changes(
                    page, new_index, 'added', opts, budget, resources=new_page_resources
                )
                pages.append(
                    {
                        'oldIndex': None,
                        'newIndex': new_index,
                        'status': 'added',
                        'oldSize': None,
                        'newSize': {
                            'width': _number(page.get('width')),
                            'height': _number(page.get('height')),
                        },
                        'match': None,
                        'changes': changes,
                    }
                )
            elif new_index is None:
                page = _extract_page(
                    old_extractor, old_index, old_file, 'old', page_types
                )
                changes, page_truncated = _one_sided_changes(
                    page, old_index, 'removed', opts, budget, resources=old_page_resources
                )
                pages.append(
                    {
                        'oldIndex': old_index,
                        'newIndex': None,
                        'status': 'removed',
                        'oldSize': {
                            'width': _number(page.get('width')),
                            'height': _number(page.get('height')),
                        },
                        'newSize': None,
                        'match': None,
                        'changes': changes,
                    }
                )
            elif unchanged_pair:
                changes, page_truncated = [], False
                pages.append(
                    {
                        'oldIndex': old_index,
                        'newIndex': new_index,
                        'status': 'unchanged',
                        'oldSize': _signature_size(old_signatures[old_index - 1]),
                        'newSize': _signature_size(new_signatures[new_index - 1]),
                        'match': {
                            'score': 1.0,
                            'reordered': old_index != new_index,
                        },
                        'changes': [],
                    }
                )
            elif resource_only_pair:
                # Empty page dicts: no object type has anything to compare, so
                # only the resource comparison runs.  ``include_page_geometry``
                # is off because the signatures prove the geometry is equal.
                changes, page_truncated = _diff_pair_changes(
                    {},
                    {},
                    opts,
                    old_index,
                    new_index,
                    include_page_geometry=False,
                    max_changes=budget,
                    old_resources=old_page_resources,
                    new_resources=new_page_resources,
                )
                pages.append(
                    {
                        'oldIndex': old_index,
                        'newIndex': new_index,
                        'status': 'changed' if changes else 'unchanged',
                        'oldSize': _signature_size(old_signatures[old_index - 1]),
                        'newSize': _signature_size(new_signatures[new_index - 1]),
                        'match': {
                            'score': 1.0,
                            'reordered': old_index != new_index,
                        },
                        'changes': changes,
                    }
                )
            else:
                old_page = _extract_page(
                    old_extractor, old_index, old_file, 'old', page_types
                )
                new_page = _extract_page(
                    new_extractor, new_index, new_file, 'new', page_types
                )
                changes, page_truncated = _diff_pair_changes(
                    old_page,
                    new_page,
                    opts,
                    old_index,
                    new_index,
                    max_changes=budget,
                    old_resources=old_page_resources,
                    new_resources=new_page_resources,
                )
                pages.append(
                    {
                        'oldIndex': old_index,
                        'newIndex': new_index,
                        'status': 'changed' if changes else 'unchanged',
                        'oldSize': {
                            'width': _number(old_page.get('width')),
                            'height': _number(old_page.get('height')),
                        },
                        'newSize': {
                            'width': _number(new_page.get('width')),
                            'height': _number(new_page.get('height')),
                        },
                        'match': {
                            'score': page_match_score(
                                old_fingerprints[old_index - 1],
                                new_fingerprints[new_index - 1],
                            ),
                            'reordered': old_index != new_index,
                        },
                        'changes': changes,
                    }
                )

            budget = max(0, budget - len(changes))
            if page_truncated:
                truncated = True
            elif budget_spent and (
                not resources_equal
                or _page_still_differs(
                    old_fingerprints, new_fingerprints, old_index, new_index
                )
            ):
                # The budget was already spent when this page came up, so it was
                # not compared.  Its fingerprint (or its resource digest) still
                # says it differs, or it is one-sided, which means the report
                # stops before real changes: flag the truncation instead of
                # silently calling it unchanged.
                truncated = True

            _emit_progress(
                progress, {'stage': 'pages', 'done': index + 1, 'total': len(pairs)}
            )

        all_changes = [change for page in pages for change in page['changes']]
        # Resource changes never enter the object counters: a consumer that
        # counts objects keeps seeing object-only numbers.
        resource_changes = [
            change for change in all_changes if change['type'] in _RESOURCE_TYPE_SET
        ]
        document_changes = _document_changes(old_resources, new_resources, opts)
        summary = {
            'pagesAdded': sum(1 for page in pages if page['status'] == 'added'),
            'pagesRemoved': sum(1 for page in pages if page['status'] == 'removed'),
            'pagesChanged': sum(1 for page in pages if page['status'] == 'changed'),
            'pagesReordered': sum(
                1 for page in pages if (page['match'] or {}).get('reordered')
            ),
            'objectsAdded': sum(
                1 for change in all_changes
                if change['kind'] == 'added' and change['type'] not in _RESOURCE_TYPE_SET
            ),
            'objectsRemoved': sum(
                1 for change in all_changes
                if change['kind'] == 'removed' and change['type'] not in _RESOURCE_TYPE_SET
            ),
            'objectsMoved': sum(
                1 for change in all_changes
                if change['kind'] == 'moved' and change['type'] not in _RESOURCE_TYPE_SET
            ),
            'objectsModified': sum(
                1 for change in all_changes
                if change['kind'] == 'modified' and change['type'] not in _RESOURCE_TYPE_SET
            ),
            # True when the change lists above are incomplete: the change budget
            # was spent, a page could not be compared, or a compared resource
            # block hit a collector cap (see ``resourcesTruncated``).
            'changesTruncated': truncated,
        }
        # Resource counters are additive and only present when the run actually
        # compared resources, so an object-only result keeps its historical
        # shape (and old JSON consumers see exactly the fields they know).
        if resource_changes or document_changes:
            summary['resourcesAdded'] = sum(
                1 for change in resource_changes if change['kind'] == 'added'
            )
            summary['resourcesRemoved'] = sum(
                1 for change in resource_changes if change['kind'] == 'removed'
            )
            summary['resourcesModified'] = sum(
                1 for change in resource_changes if change['kind'] == 'modified'
            )
            # Moved resources live in their page's change list; without this
            # counter a report could list a move while claiming 0/0/0.
            summary['resourcesMoved'] = sum(
                1 for change in resource_changes if change['kind'] == 'moved'
            )
            summary['documentChanges'] = len(document_changes)
        if resources_truncated:
            # Same safety meaning as ``changesTruncated``: some compared resource
            # block hit a collector cap or could not be read, so the resource
            # comparison is incomplete even when no change was reported.
            summary['resourcesTruncated'] = True

        _emit_progress(
            progress,
            {
                'stage': 'done',
                'oldPages': old_page_count,
                'newPages': new_page_count,
                'pages': len(pages),
            },
        )

        result: dict[str, Any] = {
            'schemaVersion': SCHEMA_VERSION,
            'tool': {'name': TOOL_NAME, 'version': tool_version()},
            'options': options_to_dict(opts),
            'old': {'pages': old_page_count, 'sha256': old_sha256},
            'new': {'pages': new_page_count, 'sha256': new_sha256},
            'summary': summary,
            # Mirrors summary.changesTruncated; kept top level so a consumer that
            # only looks at counts can still tell the run hit the safety cap.
            'truncated': truncated,
        }
        if document_changes:
            # Metadata/page labels only: page-level resources live in
            # pages[].changes, so nothing is reported twice.
            result['documentChanges'] = document_changes
        result['pages'] = pages
        return result
    finally:
        _close_extractor(old_extractor)
        _close_extractor(new_extractor)


__all__ = [
    'DiffError',
    'DiffOptions',
    'CHANGE_TYPE_ORDER',
    'DIFF_TYPES',
    'DOCUMENT_CHANGE_TYPES',
    'MAX_DIFF_CHANGES',
    'METADATA_FIELDS',
    'RESOURCE_TYPES',
    'SCHEMA_VERSION',
    'TOOL_NAME',
    'bbox_intersects',
    'change_is_ignored',
    'diff_files',
    'diff_pages',
    'document_resource_comparison_enabled',
    'normalize_ignore_regions',
    'normalize_text',
    'options_to_dict',
    'page_fingerprint',
    'page_match_score',
    'page_resource_comparison_enabled',
    'pair_pages',
    'resource_comparison_enabled',
    'resource_comparison_incomplete',
    'tool_version',
]
