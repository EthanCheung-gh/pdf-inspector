"""Deterministic discovery and aggregation for directory audits.

:func:`audit_file` audits a single PDF; this module turns a directory tree into
one aggregate payload by discovering PDFs (:func:`discover_pdfs`), auditing each
of them sequentially and folding the per-file ``AuditReport`` summaries into one
``BatchReport`` (:func:`audit_directory`).  The CLI ``audit-dir`` command, the
directory mode of the audit action and the batch HTML report all consume these
two functions, so the batch schema lives in exactly one place.

Two properties matter for CI artifacts and are enforced by construction:

* **Determinism.**  Files are ordered by their relative POSIX path (casefold,
  then exact text for a stable tie-break), keys are emitted in a fixed order and
  the payload carries no timestamps, host names or absolute paths: ``root``
  keeps only the directory name and every path is relative to it.  Two runs over
  the same tree therefore serialise byte-identically.
* **A broken file is data, not a crash.**  Every per-file failure
  (``AuditError``, ``OSError`` or any other ``Exception``) becomes one
  ``status: "error"`` entry with a single-line message and the rest of the batch
  is still audited.  Failed files count towards ``summary.failed`` and
  ``summary.errors``, so a ``--fail-on error`` gate sees them.

Discovery rules are deliberately narrow and auditable: only regular files whose
suffix is ``.pdf`` (case-insensitive) are collected, symlinked files and
symlinked directories are skipped, and hidden entries (``.`` prefix) plus the
``node_modules``/``.git``/``.hg``/``.svn``/``__pycache__`` directories are
pruned.  ``include``/``exclude`` are ``fnmatch`` globs matched against the
relative POSIX path; several includes are OR-ed and an exclude always wins.

File names are bytes on POSIX, so a name that is not valid UTF-8 would decode to
lone surrogates that no JSON or HTML payload can encode.  Every reported path is
therefore sanitised to valid UTF-8 with the offending bytes made visible as
escapes (``bad\\udcff.pdf``), while :attr:`BatchEntry.absolute` keeps the raw
name so the file is still audited.
"""

from __future__ import annotations

import fnmatch
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, Sequence, Tuple, Union

try:  # imported as ``sidecar.batch_audit`` (namespace package)
    from .audit import audit_file
    from .audit import SCHEMA_VERSION as AUDIT_SCHEMA_VERSION
    from .audit import tool as audit_tool
except ImportError:  # executed as a script with ``sidecar/`` on sys.path
    from audit import audit_file
    from audit import SCHEMA_VERSION as AUDIT_SCHEMA_VERSION
    from audit import tool as audit_tool

# Default and maximum number of files one batch may audit.  Going over the
# limit is an error instead of a silent subset, so a batch never reports
# coverage it did not have.
DEFAULT_MAX_FILES = 500
MAX_FILES_LIMIT = 5000

# Directories that never contain project PDF content worth auditing.  Hidden
# directories (``.`` prefix) are pruned separately, which also covers ``.git``
# and friends; the explicit set keeps the rule readable and survives a future
# change of the hidden-directory policy.
SKIPPED_DIRECTORIES = frozenset(
    {'node_modules', '.git', '.hg', '.svn', '__pycache__'}
)

# Only this suffix is collected, compared case-insensitively.
PDF_SUFFIX = '.pdf'

# A batch payload always starts at this version; bump it with the schema.
BATCH_SCHEMA_VERSION = 1

# ``<scheme>://`` marks a URL, which is never a local directory.  A Windows
# drive path (``C:/docs``) has no ``//`` and is unaffected.
_URL_PATTERN = re.compile(r'^[A-Za-z][A-Za-z0-9+.\-]*://')

# ``progress(done, total, path)`` hook used by the CLI for stderr progress.
ProgressCallback = Callable[[int, int, str], None]

# One glob, or several; a bare string is one pattern, never a character sequence.
GlobPatterns = Union[str, bytes, os.PathLike, Iterable[Union[str, bytes, os.PathLike]]]


class BatchAuditError(ValueError):
    """Raised when a directory audit input cannot be discovered or validated.

    Subclasses :class:`ValueError`, like :class:`sidecar.audit.AuditError`, so
    the CLI reports it as a user error (``pdf-inspector: error: ...``, exit 2)
    rather than a traceback.
    """


@dataclass(frozen=True)
class BatchEntry:
    """One discovered PDF.

    ``path`` is the relative POSIX path from the audited root and is the only
    path ever serialised.  ``absolute`` is the internal handle passed to
    :func:`sidecar.audit.audit_file`; it must never reach the payload.  ``path``
    is always valid UTF-8 (see :func:`_display_path`); ``absolute`` keeps the
    file name exactly as the filesystem reported it.
    """

    path: str
    absolute: Path
    size: int


# --- input validation -------------------------------------------------------


def _validate_max_files(max_files: Any) -> int:
    """Return ``max_files`` as an ``int`` in ``1..MAX_FILES_LIMIT``."""
    if isinstance(max_files, bool) or not isinstance(max_files, int):
        raise BatchAuditError(
            'max_files must be an integer between 1 and '
            f'{MAX_FILES_LIMIT}, got {max_files!r}'
        )
    if not 1 <= max_files <= MAX_FILES_LIMIT:
        raise BatchAuditError(
            f'max_files must be between 1 and {MAX_FILES_LIMIT}, '
            f'got {max_files}'
        )
    return max_files


def _source_text(root: Any) -> str:
    """The root as a decoded path string, rejecting non path-like values."""
    if root is None:
        raise BatchAuditError('root must be a local directory, not None')
    try:
        return os.fsdecode(os.fspath(root))
    except TypeError:
        raise BatchAuditError(
            f'root must be a local directory path, got {type(root).__name__}'
        ) from None


def _display_name(source: str, directory: Path) -> str:
    """The root's own name: only the basename is ever reported.

    A path without a usable basename (``.``, ``..``, ``/``) falls back to the
    resolved directory and finally to ``'.'``.
    """
    name = Path(source).name
    if name in ('', '.', '..'):
        name = directory.name
    return name or '.'


def _resolve_root(root: Any) -> Tuple[Path, str]:
    """Validate ``root`` and return ``(resolved directory, display name)``."""
    source = _source_text(root)
    if not source.strip():
        raise BatchAuditError('root must be a local directory, not an empty path')
    if _URL_PATTERN.match(source):
        raise BatchAuditError(
            f'root must be a local directory, not a URL: {source}'
        )

    directory = Path(source)
    try:
        is_directory = directory.is_dir()
    except OSError:  # pragma: no cover - defensive, is_dir swallows most errors
        is_directory = False
    if not is_directory:
        if directory.exists():
            raise BatchAuditError(f'root is not a directory: {source}')
        raise BatchAuditError(f'root does not exist or is not a directory: {source}')

    if not os.access(directory, os.R_OK | os.X_OK):
        raise BatchAuditError(f'root is not readable: {source}')

    resolved = directory.resolve()
    return resolved, _display_name(source, resolved)


def _normalize_patterns(values: Any) -> Tuple[str, ...]:
    """Normalise ``include``/``exclude`` into a tuple of glob strings.

    A bare string is one pattern, never a sequence of characters; ``None`` and
    empty values mean "no pattern".
    """
    if values is None:
        return ()
    if isinstance(values, (str, bytes, os.PathLike)):
        values = (values,)
    patterns: list[str] = []
    for value in values:
        if value is None:
            continue
        try:
            pattern = os.fsdecode(os.fspath(value))
        except TypeError:
            raise BatchAuditError(
                f'glob patterns must be strings, got {type(value).__name__}'
            ) from None
        if pattern.strip():
            patterns.append(pattern)
    return tuple(patterns)


def _selects(path: str, includes: Sequence[str], excludes: Sequence[str]) -> bool:
    """Apply include (OR) then exclude (wins) to a relative POSIX path."""
    for pattern in excludes:
        if fnmatch.fnmatchcase(path, pattern):
            return False
    if not includes:
        return True
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in includes)


# --- discovery --------------------------------------------------------------


def _display_path(value: str) -> str:
    """A payload-safe path: valid UTF-8, with surrogates made visible.

    POSIX file names are bytes, so a name that is not valid UTF-8 decodes (with
    ``surrogateescape``) into lone surrogates such as ``'bad\\udcff.pdf'``.  The
    batch payload is UTF-8 text -- JSON and HTML both refuse to encode those
    characters -- so the path that is reported, sorted, matched against globs and
    printed as progress is the ``backslashreplace`` form, i.e. the visible escape
    ``bad\\udcff.pdf`` written as those eleven ASCII characters.  The raw name
    stays in :attr:`BatchEntry.absolute`, so the file is still opened and
    audited.  Names that are already valid UTF-8 are returned unchanged.

    ``surrogatepass`` is deliberately not used: it would emit bytes that are not
    valid UTF-8 at all, which is exactly what the payload must avoid.
    """
    try:
        value.encode('utf-8')
    except UnicodeEncodeError:
        return value.encode('utf-8', 'backslashreplace').decode('utf-8')
    return value


def _walk_error(error: OSError) -> None:
    """Turn an ``os.walk`` read error into a loud ``BatchAuditError``."""
    raise BatchAuditError(
        f'cannot read directory while discovering PDFs: {error}'
    ) from error


def _is_skipped_directory(name: str, absolute: str) -> bool:
    """Hidden, well-known and symlinked directories are never entered."""
    if name.startswith('.') or name in SKIPPED_DIRECTORIES:
        return True
    return os.path.islink(absolute)


def _file_size(path: Path) -> int:
    """``stat().st_size``; a file that vanished meanwhile keeps size 0.

    The disappearance itself is reported per file when the audit runs, because
    only then is the failure attributable to a specific entry.
    """
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _discover(
    root: Any,
    include: Any,
    exclude: Any,
    max_files: Any,
) -> Tuple[str, list[BatchEntry]]:
    """Shared implementation: ``(root display name, ordered entries)``."""
    limit = _validate_max_files(max_files)
    directory, name = _resolve_root(root)
    includes = _normalize_patterns(include)
    excludes = _normalize_patterns(exclude)

    entries: list[BatchEntry] = []
    for current, dirnames, filenames in os.walk(
        directory, followlinks=False, onerror=_walk_error
    ):
        # Prune in place so the walk never descends into skipped directories.
        dirnames[:] = [
            dirname
            for dirname in dirnames
            if not _is_skipped_directory(dirname, os.path.join(current, dirname))
        ]
        for filename in filenames:
            if filename.startswith('.'):
                continue
            if Path(filename).suffix.lower() != PDF_SUFFIX:
                continue
            absolute = Path(current) / filename
            if absolute.is_symlink():
                continue
            # ``relpath`` keeps this lexical (the resolved root has no ``..``);
            # ``as_posix`` makes the serialised path separator platform-neutral.
            relative = Path(os.path.relpath(absolute, directory)).as_posix()
            # Only the reported path is sanitised; ``absolute`` keeps the raw
            # name so the audit still opens the real file.
            display = _display_path(relative)
            if not _selects(display, includes, excludes):
                continue
            entries.append(
                BatchEntry(path=display, absolute=absolute, size=_file_size(absolute))
            )

    if len(entries) > limit:
        raise BatchAuditError(
            f'found {len(entries)} PDF files under root {name!r}, '
            f'more than the limit of {limit} (max_files)'
        )

    # Casefold first for a case-insensitive reading, exact text second so the
    # order never depends on the platform's directory listing order.
    entries.sort(key=lambda entry: (entry.path.casefold(), entry.path))
    return name, entries


def discover_pdfs(
    root: Union[str, os.PathLike],
    include: GlobPatterns = (),
    exclude: GlobPatterns = (),
    max_files: int = DEFAULT_MAX_FILES,
) -> list[BatchEntry]:
    """Discover the PDFs under the local directory ``root``.

    Recurses without following symlinks, skips hidden files and directories,
    prunes :data:`SKIPPED_DIRECTORIES`, keeps only ``.pdf`` files
    (case-insensitive) that match ``include`` (OR-ed globs, empty = all) and no
    ``exclude`` glob, and returns them ordered by relative POSIX path.

    Raises :class:`BatchAuditError` when ``root`` is a URL, missing, not a
    directory or unreadable, when ``max_files`` is not an ``int`` in
    ``1..MAX_FILES_LIMIT``, when more files are found than ``max_files``, or when
    the tree cannot be traversed.  An empty directory is not an error.
    """
    return _discover(root, include, exclude, max_files)[1]


# --- aggregation ------------------------------------------------------------


def _one_line(value: Any) -> str:
    """Collapse arbitrary exception text into exactly one line."""
    text = value if isinstance(value, str) else str(value)
    return ' '.join(text.split())


def _error_text(error: Exception, entry: BatchEntry) -> str:
    """One line of error text with absolute paths rewritten to ``entry.path``.

    ``audit_file`` embeds the path it was given in its message (``Cannot open
    PDF '/abs/docs/a.pdf': ...``).  The batch payload is relative by contract, so
    the entry's absolute path is replaced with its relative path; an exception
    without a message falls back to its type name so the line is never empty.
    The result is sanitised like every other reported path, so an error raised
    for a file whose name is not valid UTF-8 stays encodable.

    The message may spell that path three ways -- the raw string, the
    ``backslashreplace`` form and the ``repr`` interior (``audit.py`` formats it
    with ``!r``, which escapes a lone surrogate as ``\\udcff``) -- so all of them
    are replaced.  Otherwise an absolute path would leak for exactly the names
    this module sanitises.
    """
    try:
        text = _one_line(error)
    except Exception:  # pragma: no cover - defensive, __str__ imploded
        text = ''
    if not text:
        text = type(error).__name__
    absolute = str(entry.absolute)
    if absolute and absolute != entry.path:
        for spelling in (absolute, _display_path(absolute), ascii(absolute)[1:-1]):
            if spelling and spelling != entry.path:
                text = text.replace(spelling, entry.path)
    return _display_path(text)


def _count(value: Any) -> int:
    """Coerce a summary counter to a non-negative int."""
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return 0


def _success_entry(entry: BatchEntry, report: dict[str, Any]) -> dict[str, Any]:
    """One ``status: "ok"`` file entry: the report fields, verbatim.

    ``findings`` keeps the full findings including ``fingerprint`` so a batch
    payload can be split back into single-file reports without re-auditing.
    """
    return {
        'path': entry.path,
        'status': 'ok',
        'bytes': entry.size,
        'document': report.get('document'),
        'summary': report.get('summary'),
        'findings': report.get('findings') or [],
    }


def _failure_entry(entry: BatchEntry, error: Exception) -> dict[str, Any]:
    """One ``status: "error"`` file entry; no document/summary/findings."""
    return {
        'path': entry.path,
        'status': 'error',
        'bytes': entry.size,
        'error': _error_text(error, entry),
    }


def _notify(
    progress: Optional[ProgressCallback], done: int, total: int, path: str
) -> None:
    """Call the progress hook, swallowing its own failures.

    Progress reporting is a convenience for the CLI, never a reason to lose an
    audit result, so any exception raised by the callback is ignored.
    """
    if progress is None:
        return
    try:
        progress(done, total, path)
    except Exception:
        pass


def audit_directory(
    root: Union[str, os.PathLike],
    include: GlobPatterns = (),
    exclude: GlobPatterns = (),
    max_files: int = DEFAULT_MAX_FILES,
    progress: Optional[ProgressCallback] = None,
) -> dict[str, Any]:
    """Audit every discovered PDF under ``root`` and aggregate the results.

    Files are audited sequentially in discovery order (relative POSIX path).
    ``progress(done, total, path)`` is called **before** each file is audited,
    with ``done`` counting the files already completed (``0`` for the first file,
    ``total - 1`` for the last) and ``path`` the relative POSIX path -- so a
    caller prints ``[done + 1/total] path`` while that file is being processed.
    Exceptions raised by the callback are swallowed.

    Returns a ``BatchReport``::

        {"schemaVersion": 1, "tool": {...},
         "root": {"name": "docs", "files": 3, "bytes": 123456},
         "summary": {"files": 3, "audited": 2, "failed": 1, "findings": 6,
                     "errors": 2, "warnings": 3, "info": 1},
         "files": [...]}

    ``summary.errors`` counts finding errors plus failed files; ``findings`` is
    the total of all per-file findings.  Raises :class:`BatchAuditError` for the
    same discovery/argument problems as :func:`discover_pdfs`; a single file
    that cannot be read never aborts the batch.
    """
    if progress is not None and not callable(progress):
        raise BatchAuditError(
            f'progress must be callable, got {type(progress).__name__}'
        )

    name, entries = _discover(root, include, exclude, max_files)
    total = len(entries)
    summary = {
        'files': total,
        'audited': 0,
        'failed': 0,
        'findings': 0,
        'errors': 0,
        'warnings': 0,
        'info': 0,
    }

    files: list[dict[str, Any]] = []
    for done, entry in enumerate(entries):
        _notify(progress, done, total, entry.path)
        try:
            report = audit_file(entry.absolute)
        except Exception as error:
            # ``AuditError`` for input that cannot be opened, ``OSError`` for a
            # file that vanished, and anything else pdfminer raises: all of them
            # are one bad file, never the end of the batch.
            files.append(_failure_entry(entry, error))
            summary['failed'] += 1
            continue

        files.append(_success_entry(entry, report))
        counts = report.get('summary') or {}
        summary['audited'] += 1
        summary['findings'] += _count(counts.get('total'))
        summary['errors'] += _count(counts.get('errors'))
        summary['warnings'] += _count(counts.get('warnings'))
        summary['info'] += _count(counts.get('info'))

    # A failed file is an error in the aggregate, so ``--fail-on error`` gates it.
    summary['errors'] += summary['failed']

    return {
        'schemaVersion': BATCH_SCHEMA_VERSION,
        'tool': audit_tool(),
        'root': {
            'name': name,
            'files': total,
            'bytes': sum(entry.size for entry in entries),
        },
        'summary': summary,
        'files': files,
    }


__all__ = [
    # ``AUDIT_SCHEMA_VERSION`` is re-exported so U2/U3 can assert that the
    # batch and single-file payload versions agree.
    'AUDIT_SCHEMA_VERSION',
    'BATCH_SCHEMA_VERSION',
    'BatchAuditError',
    'BatchEntry',
    'DEFAULT_MAX_FILES',
    'GlobPatterns',
    'MAX_FILES_LIMIT',
    'PDF_SUFFIX',
    'SKIPPED_DIRECTORIES',
    'audit_directory',
    'discover_pdfs',
]
