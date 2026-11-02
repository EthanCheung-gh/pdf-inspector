"""Object-level PDF diff engine.

The engine is deliberately transport agnostic: the CLI, the HTTP endpoint and
the desktop RPC all call :func:`diff_files` and serialise the returned dict, so
every surface shares one deterministic implementation.

Coordinates are the same MediaBox-relative PDF points the extractor reports;
pages are paired with :class:`difflib.SequenceMatcher` on lightweight page
fingerprints, and each object type is matched independently with a
deterministic greedy minimum-cost matcher (stable sorting, no randomness, no
timestamps).  File handles are always released, and unreadable PDFs raise
:class:`DiffError` with a human readable message.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

try:  # imported as ``sidecar.diff`` (namespace package)
    from .extractor import PdfExtractor
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from extractor import PdfExtractor


SCHEMA_VERSION = 1
TOOL_NAME = 'pdf-inspector'

# Object types in the order the diff reports and sorts them.
DIFF_TYPES = ('word', 'char', 'rect', 'line', 'curve', 'image', 'table')
TEXT_TYPES = frozenset({'word', 'char'})
TEXT_TOLERANCES = ('exact', 'normalized', 'case-insensitive')

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

_PACKAGE_JSON = Path(__file__).resolve().parent.parent / 'package.json'


class DiffError(Exception):
    """Raised when a diff input cannot be read or parsed.

    The message is meant for a CLI/user, never a traceback dump.
    """


@dataclass
class DiffOptions:
    """Tunables for :func:`diff_files`.

    ``ignore_fonts`` covers font name and font size; ``ignore_colors`` covers
    stroke/char colour fields; ``ignore_images`` is equivalent to adding
    ``"image"`` to ``ignore_types``.
    """

    position_tolerance: float = 1.0
    text_tolerance: str = 'normalized'
    ignore_types: set[str] = field(default_factory=set)
    ignore_fonts: bool = False
    ignore_colors: bool = False
    ignore_images: bool = False

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
    bbox = change.get('oldBBox') or change.get('newBBox') or {}
    return (
        DIFF_TYPES.index(change['type']),
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
) -> list[dict[str, Any]]:
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
) -> list[dict[str, Any]]:
    """Match rect/line/curve/image/table objects by place and by signature.

    Positional closeness yields unchanged/modified objects; identical
    signatures (size/angle/point count/content hash/cells) pair the leftovers so
    a relocated object is reported as moved instead of removed+added.
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
        changes.append(_make_change('removed', type_, old_page, None, old_obj=obj))
    for index, obj in enumerate(new_objects):
        if index in matched_new:
            continue
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


def diff_pages(
    old_page: Mapping[str, Any],
    new_page: Mapping[str, Any],
    options: Optional[DiffOptions] = None,
    old_index: int = 1,
    new_index: int = 1,
    include_page_geometry: bool = True,
) -> list[dict[str, Any]]:
    """Diff two extracted pages and return the sorted change list.

    Exposed for unit tests and for consumers that already hold page data; the
    page objects are the dicts returned by ``PdfExtractor.extract_page``.
    """
    opts = options if options is not None else DiffOptions()
    if not isinstance(opts, DiffOptions):
        raise TypeError('options must be a DiffOptions instance')

    changes: list[dict[str, Any]] = []
    if include_page_geometry:
        geometry_change = _page_geometry_change(old_page, new_page, old_index, new_index)
        if geometry_change is not None:
            changes.append(geometry_change)

    for type_ in DIFF_TYPES:
        if _is_ignored(type_, opts):
            continue
        old_objects = _page_objects(old_page, type_)
        new_objects = _page_objects(new_page, type_)
        if not old_objects and not new_objects:
            continue
        if type_ in TEXT_TYPES:
            changes.extend(
                _diff_text_objects(
                    type_, old_objects, new_objects, opts, old_index, new_index
                )
            )
        else:
            changes.extend(
                _diff_structural_objects(
                    type_, old_objects, new_objects, opts, old_index, new_index
                )
            )
    return _sort_changes(changes)


def _one_sided_changes(
    page: Mapping[str, Any],
    page_num: int,
    kind: str,
    options: DiffOptions,
) -> list[dict[str, Any]]:
    """Every object of an added/removed page becomes one added/removed change."""
    changes: list[dict[str, Any]] = []
    for type_ in DIFF_TYPES:
        if _is_ignored(type_, options):
            continue
        for obj in _page_objects(page, type_):
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
    return _sort_changes(changes)


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
    """Serialise options with the contract's camelCase keys."""
    ignored = set(options.ignore_types)
    return {
        'positionTolerance': float(options.position_tolerance),
        'textTolerance': options.text_tolerance,
        'ignoreTypes': [type_ for type_ in DIFF_TYPES if type_ in ignored],
        'ignoreFonts': bool(options.ignore_fonts),
        'ignoreColors': bool(options.ignore_colors),
        'ignoreImages': bool(options.ignore_images),
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


def _extract_page(extractor: PdfExtractor, page_num: int, path: Path, label: str) -> dict:
    try:
        page_data = extractor.extract_page(page_num)
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


def diff_files(
    old_path: str | Path,
    new_path: str | Path,
    options: Optional[DiffOptions] = None,
) -> dict[str, Any]:
    """Diff two PDF files and return a JSON-serialisable ``DiffResult``.

    Pages are read one at a time: a fingerprint pass pairs the pages, the diff
    pass extracts only the two pages of the current pair.  Both extractors are
    closed whether the diff succeeds or fails.
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

        old_fingerprints = [
            page_fingerprint(
                _extract_page(old_extractor, page_num, old_file, 'old')
            )
            for page_num in range(1, old_page_count + 1)
        ]
        new_fingerprints = [
            page_fingerprint(
                _extract_page(new_extractor, page_num, new_file, 'new')
            )
            for page_num in range(1, new_page_count + 1)
        ]

        pages: list[dict[str, Any]] = []
        for old_index, new_index in pair_pages(old_fingerprints, new_fingerprints):
            if old_index is None and new_index is None:  # pragma: no cover - defensive
                continue
            if old_index is None:
                page = _extract_page(new_extractor, new_index, new_file, 'new')
                changes = _one_sided_changes(page, new_index, 'added', opts)
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
                        'changes': changes,
                    }
                )
                continue
            if new_index is None:
                page = _extract_page(old_extractor, old_index, old_file, 'old')
                changes = _one_sided_changes(page, old_index, 'removed', opts)
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
                        'changes': changes,
                    }
                )
                continue

            old_page = _extract_page(old_extractor, old_index, old_file, 'old')
            new_page = _extract_page(new_extractor, new_index, new_file, 'new')
            changes = diff_pages(old_page, new_page, opts, old_index, new_index)
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
                    'changes': changes,
                }
            )

        all_changes = [change for page in pages for change in page['changes']]
        summary = {
            'pagesAdded': sum(1 for page in pages if page['status'] == 'added'),
            'pagesRemoved': sum(1 for page in pages if page['status'] == 'removed'),
            'pagesChanged': sum(1 for page in pages if page['status'] == 'changed'),
            'objectsAdded': sum(1 for change in all_changes if change['kind'] == 'added'),
            'objectsRemoved': sum(1 for change in all_changes if change['kind'] == 'removed'),
            'objectsMoved': sum(1 for change in all_changes if change['kind'] == 'moved'),
            'objectsModified': sum(1 for change in all_changes if change['kind'] == 'modified'),
        }

        return {
            'schemaVersion': SCHEMA_VERSION,
            'tool': {'name': TOOL_NAME, 'version': tool_version()},
            'options': options_to_dict(opts),
            'old': {'pages': old_page_count, 'sha256': old_sha256},
            'new': {'pages': new_page_count, 'sha256': new_sha256},
            'summary': summary,
            'pages': pages,
        }
    finally:
        _close_extractor(old_extractor)
        _close_extractor(new_extractor)


__all__ = [
    'DiffError',
    'DiffOptions',
    'DIFF_TYPES',
    'SCHEMA_VERSION',
    'TOOL_NAME',
    'diff_files',
    'diff_pages',
    'normalize_text',
    'options_to_dict',
    'page_fingerprint',
    'pair_pages',
    'tool_version',
]
