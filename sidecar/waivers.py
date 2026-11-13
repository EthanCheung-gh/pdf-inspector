"""Expiring finding waivers: strict parsing, matching and expiry.

A waiver file is a *policy* file a repository commits, not an implicit ignore
list: every entry must name the finding ``fingerprint``, a ``reason`` and an
``expires`` date, and may narrow the match to one ``page``.  The format is
deliberately tiny and strictly validated, so a typo fails the run instead of
silently suppressing a finding::

    {
      "schemaVersion": 1,
      "waivers": [
        {
          "fingerprint": "0123456789abcdef0123456789abcdef",
          "page": 7,
          "reason": "Legacy template; tracked in DOC-1234",
          "expires": "2026-12-31"
        }
      ]
    }

Everything here is a pure function over the waiver file and the current
findings: no PDF is opened, no network is used, no finding dict is mutated, and
the current date is injected so tests never depend on the wall clock.

Semantics:

* a waiver matches a finding by ``fingerprint`` and, when ``page`` is set, by
  exact page (``page`` omitted or ``null`` matches any page);
* one finding matches at most one waiver (the first entry in file order);
* ``expires`` is inclusive: the waiver still applies on its expiry date and is
  expired from the following day;
* an expired waiver is never applied and never counted as unused;
* an ``applied`` waiver that matched no finding is reported as ``unused`` so a
  stale policy entry can be cleaned up.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence, Union

try:  # imported as ``sidecar.waivers`` (namespace package)
    from .audit import FINGERPRINT_KEY, finding_fingerprint
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from audit import FINGERPRINT_KEY, finding_fingerprint


WAIVER_SCHEMA_VERSION = 1

# The only keys one waiver entry may carry, in the documented order.
WAIVER_KEYS = ('fingerprint', 'page', 'reason', 'expires')

# Counter keys of a :class:`WaiverApplication`, in display order.
WAIVER_COUNT_KEYS = ('applied', 'expired', 'unused')

# A fingerprint is the engine's truncated SHA-256: 32 lowercase hex chars.
FINGERPRINT_PATTERN = re.compile(r'\A[0-9a-f]{32}\Z')

# ``expires`` is a calendar date only: no time, no zone, no offsets.
EXPIRES_PATTERN = re.compile(r'\A\d{4}-\d{2}-\d{2}\Z')

# A reason shorter than this after stripping is not a policy statement.
MIN_REASON_LENGTH = 3


class WaiverError(ValueError):
    """A waiver input that cannot be read or does not follow the contract.

    Subclasses :class:`ValueError` so the CLI and the RPC layer report it as a
    user error (one message, never a traceback) through their existing paths.
    """


# --- data model -------------------------------------------------------------


@dataclass(frozen=True)
class Waiver:
    """One validated waiver entry.

    ``page`` is ``None`` for "any page".  ``expires`` is a :class:`datetime.date`
    so expiry is a plain date comparison; :attr:`expires_text` is the ISO form
    used by the comparison artifact and the renderers.
    """

    fingerprint: str
    page: Optional[int]
    reason: str
    expires: date

    @property
    def expires_text(self) -> str:
        """``YYYY-MM-DD``, the serialized form of :attr:`expires`."""
        return self.expires.isoformat()

    def is_expired(self, today: date) -> bool:
        """True from the day after ``expires`` onwards (the date itself is valid)."""
        return self.expires < today

    def as_dict(self) -> dict[str, Any]:
        """The documented JSON shape of one entry (``page`` may be ``None``)."""
        return {
            'fingerprint': self.fingerprint,
            'page': self.page,
            'reason': self.reason,
            'expires': self.expires_text,
        }


@dataclass(frozen=True)
class WaiverApplication:
    """The result of matching a waiver set against the current findings.

    ``applied`` maps the index of the current finding (report order) to the
    waiver that accepts it, so a renderer can mark exactly that finding.
    ``expired`` and ``unused`` stay in file order and are already disjoint.
    """

    applied: Mapping[int, Waiver]
    expired: tuple[Waiver, ...] = ()
    unused: tuple[Waiver, ...] = ()

    @property
    def applied_count(self) -> int:
        return len(self.applied)

    @property
    def expired_count(self) -> int:
        return len(self.expired)

    @property
    def unused_count(self) -> int:
        return len(self.unused)

    @property
    def counts(self) -> dict[str, int]:
        """``{"applied": n, "expired": n, "unused": n}`` in display order."""
        values = {
            'applied': self.applied_count,
            'expired': self.expired_count,
            'unused': self.unused_count,
        }
        return {key: values[key] for key in WAIVER_COUNT_KEYS}

    def applied_waivers(self) -> list[Waiver]:
        """Applied waivers ordered by current-finding index (deterministic)."""
        return [self.applied[index] for index in sorted(self.applied)]


# --- loading ----------------------------------------------------------------


def load_waivers(
    path: Union[str, Path],
    today: Optional[date] = None,
) -> tuple[Waiver, ...]:
    """Read and strictly validate a waiver file from a local JSON file.

    Only local files are accepted (no URLs).  The file must be a JSON object with
    ``schemaVersion`` 1 and a ``waivers`` array of objects carrying exactly the
    documented keys.  Any violation raises :class:`WaiverError` with one clear
    message; nothing is ever repaired silently.

    ``today`` is accepted for symmetry with :func:`apply_waivers` but plays no
    part in loading: expiry is decided when the waivers are applied, so the same
    validated set can be reused for several runs/dates.
    """
    label = str(path)
    lowered = label.strip().lower()
    # ``Path('https://...')`` collapses the double slash to ``https:/...``, so
    # this also rejects a URL that a caller already wrapped in ``Path``.
    if lowered.startswith(('http:/', 'https:/')):
        raise WaiverError(
            f'waivers input must be a local file path, not a URL: {label} '
            '(remote inputs are not supported)'
        )

    target = Path(label)
    try:
        text = target.read_text(encoding='utf-8')
    except OSError as exc:
        raise WaiverError(f'cannot read waivers file {label!r}: {exc}') from exc

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise WaiverError(
            f'waivers file {label!r} is not valid JSON: {exc}'
        ) from exc

    return _validated_waivers(data, label)


def _validated_waivers(data: Any, label: str) -> tuple[Waiver, ...]:
    """Validate one parsed waiver document and return its entries."""
    if not isinstance(data, Mapping):
        raise WaiverError(
            f'waivers file {label!r} must contain a JSON object with '
            'schemaVersion 1 and a waivers array'
        )

    schema = data.get('schemaVersion')
    if (
        isinstance(schema, bool)
        or not isinstance(schema, int)
        or schema != WAIVER_SCHEMA_VERSION
    ):
        raise WaiverError(
            f'waivers file {label!r} must have schemaVersion 1, got {schema!r}'
        )

    entries = data.get('waivers')
    if not isinstance(entries, list):
        raise WaiverError(
            f'waivers file {label!r} must contain a waivers array'
        )

    waivers: list[Waiver] = []
    seen: dict[tuple[str, Optional[int]], int] = {}
    for position, entry in enumerate(entries, start=1):
        waiver = _validated_entry(entry, position, label)
        key = (waiver.fingerprint, waiver.page)
        if key in seen:
            raise WaiverError(
                f'waivers file {label!r} defines the same fingerprint+page twice: '
                f'waivers[{seen[key]}] and waivers[{position}]'
            )
        seen[key] = position
        waivers.append(waiver)

    return tuple(waivers)


def _validated_entry(entry: Any, position: int, label: str) -> Waiver:
    """Validate one ``waivers[i]`` object."""
    where = f'waivers file {label!r} waivers[{position}]'
    if not isinstance(entry, Mapping):
        raise WaiverError(f'{where} must be a JSON object')

    unknown = [str(key) for key in entry if key not in WAIVER_KEYS]
    if unknown:
        raise WaiverError(
            f'{where} has unknown key(s): {", ".join(sorted(unknown))} '
            f'(allowed: {", ".join(WAIVER_KEYS)})'
        )

    fingerprint = entry.get('fingerprint')
    if not isinstance(fingerprint, str) or not FINGERPRINT_PATTERN.match(fingerprint):
        raise WaiverError(
            f'{where}.fingerprint must be 32 lowercase hex characters '
            f'(got {fingerprint!r})'
        )

    page = entry.get('page')
    if page is not None:
        if isinstance(page, bool) or not isinstance(page, int) or page < 1:
            raise WaiverError(
                f'{where}.page must be a positive integer when present '
                f'(got {page!r})'
            )

    reason = entry.get('reason')
    if not isinstance(reason, str) or len(reason.strip()) < MIN_REASON_LENGTH:
        raise WaiverError(
            f'{where}.reason must be a non-empty string of at least '
            f'{MIN_REASON_LENGTH} characters (got {reason!r})'
        )

    raw_expires = entry.get('expires')
    if not isinstance(raw_expires, str) or not EXPIRES_PATTERN.match(raw_expires):
        raise WaiverError(
            f'{where}.expires must be a YYYY-MM-DD date (got {raw_expires!r})'
        )
    try:
        expires = date.fromisoformat(raw_expires)
    except ValueError as exc:
        raise WaiverError(
            f'{where}.expires is not a valid date: {raw_expires!r}'
        ) from exc

    return Waiver(
        fingerprint=fingerprint,
        page=page,
        reason=reason.strip(),
        expires=expires,
    )


# --- matching ---------------------------------------------------------------


def utc_today() -> date:
    """The default ``today``: the current UTC calendar date."""
    return datetime.now(timezone.utc).date()


def apply_waivers(
    findings: Sequence[Mapping[str, Any]],
    waivers: Iterable[Waiver],
    today: Optional[date] = None,
) -> WaiverApplication:
    """Match ``waivers`` against ``findings`` and split them into three sets.

    ``applied`` maps the index of the matched current finding (in the order of
    ``findings``) to its waiver; a finding matches at most one waiver and a
    waiver accepts at most one finding.  ``expired`` holds the waivers that are
    no longer valid on ``today`` (they never suppress anything), and ``unused``
    the still-valid waivers that matched no current finding.

    The findings are only read: no dict is added to, removed from or reordered.
    A finding without a ``fingerprint`` gets one computed by the engine function,
    exactly like baseline loading does for legacy reports.
    """
    current = utc_today() if today is None else today

    active: list[Waiver] = []
    expired: list[Waiver] = []
    for waiver in waivers:
        (expired if waiver.is_expired(current) else active).append(waiver)

    applied: dict[int, Waiver] = {}
    used: set[int] = set()
    for index, finding in enumerate(findings):
        if not isinstance(finding, Mapping):
            continue
        fingerprint = _finding_fingerprint(finding)
        page = _finding_page(finding)
        for position, waiver in enumerate(active):
            if position in used or waiver.fingerprint != fingerprint:
                continue
            if waiver.page is not None and waiver.page != page:
                continue
            applied[index] = waiver
            used.add(position)
            break

    unused = tuple(
        waiver for position, waiver in enumerate(active) if position not in used
    )
    return WaiverApplication(
        applied=applied,
        expired=tuple(expired),
        unused=unused,
    )


# --- helpers ----------------------------------------------------------------


def _finding_fingerprint(finding: Mapping[str, Any]) -> str:
    """The finding's own fingerprint, or the engine one when it is missing."""
    value = finding.get(FINGERPRINT_KEY)
    if isinstance(value, str) and value:
        return value
    return finding_fingerprint(finding)


def _finding_page(finding: Mapping[str, Any]) -> Optional[int]:
    """The finding's page as an int, or ``None`` for document-level findings."""
    page = finding.get('page')
    if isinstance(page, bool) or not isinstance(page, int):
        return None
    return page


__all__ = [
    'FINGERPRINT_PATTERN',
    'MIN_REASON_LENGTH',
    'WAIVER_COUNT_KEYS',
    'WAIVER_KEYS',
    'WAIVER_SCHEMA_VERSION',
    'Waiver',
    'WaiverApplication',
    'WaiverError',
    'apply_waivers',
    'load_waivers',
    'utc_today',
]
