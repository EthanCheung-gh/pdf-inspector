#!/usr/bin/env python3
import sys
import json
import threading
import traceback
from typing import Any, Callable, Mapping, Optional

from models import parse_request, format_response, RpcResponse
from extractor import PdfExtractor
from cache import PageCache
from diff import DiffError, DiffOptions, diff_files
from audit import (
    AuditError,
    accessibility_report,
    audit_document,
    audit_pages,
    security_report,
)
from raw import RawError, raw_document, raw_object, raw_page_content


class RpcError(Exception):
    """Protocol-level error: reported to the parent without a traceback."""


# The parent's request budget is an INACTIVITY window rearmed by progress lines,
# not a total time cap. One very large or complex page can run past that window
# without ``diff_files`` reporting anything, so a diff also emits a heartbeat.
HEARTBEAT_INTERVAL_SECONDS = 5.0

# Only ``diff_documents`` runs long enough inside a single unit of work to need
# a heartbeat. Every other method stays silent, so its budget keeps bounding
# silence exactly as before.
_HEARTBEAT_METHOD = 'diff_documents'

# Progress lines, heartbeat lines and the final response all leave through this
# lock: the heartbeat thread writes to stdout while the diff engine reports
# per-page progress, and two interleaved write()+flush() pairs would produce a
# line the parent cannot parse.
_STDOUT_LOCK = threading.Lock()


def _write_stdout_text(text: str) -> None:
    """Write ``text`` to stdout and flush it, atomically w.r.t. other writers."""
    with _STDOUT_LOCK:
        sys.stdout.write(text)
        sys.stdout.flush()


def _write_progress(request_id: int, payload: Mapping[str, Any]) -> None:
    """Emit one ``{"id", "progress"}`` line for a request."""
    _write_stdout_text(json.dumps({"id": request_id, "progress": payload}) + "\n")


class _DiffHeartbeat:
    """Keep a diff request's inactivity budget alive while one page is worked on.

    Entering starts a daemon thread that emits
    ``{"id": <request id>, "progress": {"stage": "heartbeat"}}`` every
    :data:`HEARTBEAT_INTERVAL_SECONDS`; leaving stops and *joins* it, so no
    heartbeat can outlive its request or trail the final response. The thread
    only writes progress: it never touches the diff result, so a run with and
    without heartbeats returns exactly the same dict.
    """

    def __init__(self, request_id: int):
        self._request_id = request_id
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name=f'diff-heartbeat-{request_id}',
            daemon=True,
        )

    def __enter__(self) -> '_DiffHeartbeat':
        self._thread.start()
        return self

    def __exit__(self, *_exc_info: Any) -> None:
        self._stop.set()
        self._thread.join()

    def _run(self) -> None:
        # Read the interval on every pass so tests can shorten it; the wait is
        # what the stop event interrupts.
        while not self._stop.wait(HEARTBEAT_INTERVAL_SECONDS):
            _write_progress(self._request_id, {'stage': 'heartbeat'})


def _handle_request(
    session: 'SidecarSession',
    method: str,
    params: dict[str, Any],
    request_id: int,
    progress: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    """Dispatch one request, heartbeating only while a diff runs."""
    if method != _HEARTBEAT_METHOD:
        return session.handle(method, params, request_id, progress)

    with _DiffHeartbeat(request_id):
        return session.handle(method, params, request_id, progress)


# Diff options accepted over RPC. The wire format is snake_case; the TS side
# converts its camelCase contract before sending (see src/shared/diff-types.ts).
_DIFF_OPTION_FIELDS = (
    'position_tolerance',
    'text_tolerance',
    'ignore_types',
    'ignore_fonts',
    'ignore_colors',
    'ignore_images',
    'ignore_regions',
    'ignore_annotations',
    'ignore_links',
    'ignore_forms',
    'ignore_metadata',
    'ignore_page_labels',
)

# Boolean options. A JSON ``"false"`` string would be truthy in Python, so the
# RPC rejects non-boolean values instead of silently ignoring the resource.
_DIFF_BOOLEAN_FIELDS = (
    'ignore_fonts',
    'ignore_colors',
    'ignore_images',
    'ignore_annotations',
    'ignore_links',
    'ignore_forms',
    'ignore_metadata',
    'ignore_page_labels',
)


def _parse_diff_options(raw: Any) -> DiffOptions:
    """Build ``DiffOptions`` from RPC params, rejecting unknown keys.

    Unknown options are an error rather than silently ignored: a renderer that
    still sends camelCase keys would otherwise diff with default tolerances and
    look like it worked. ``DiffOptions`` itself validates the values.
    """
    if raw is None:
        return DiffOptions()
    if not isinstance(raw, Mapping):
        raise RpcError('"options" must be an object')

    unknown = sorted(set(raw) - set(_DIFF_OPTION_FIELDS))
    if unknown:
        raise RpcError(
            f'Unknown diff option(s): {", ".join(unknown)} '
            f'(valid: {", ".join(_DIFF_OPTION_FIELDS)})'
        )

    ignore_types = raw.get('ignore_types')
    if ignore_types is not None and not isinstance(ignore_types, (list, tuple, set, frozenset)):
        raise RpcError('"ignore_types" must be an array of object types')

    ignore_regions = raw.get('ignore_regions')
    if ignore_regions is not None and not isinstance(ignore_regions, (list, tuple)):
        raise RpcError('"ignore_regions" must be an array of regions')

    for name in _DIFF_BOOLEAN_FIELDS:
        value = raw.get(name)
        if value is not None and not isinstance(value, bool):
            raise RpcError(f'"{name}" must be a boolean')

    try:
        return DiffOptions(**raw)
    except (TypeError, ValueError) as exc:
        raise RpcError(str(exc)) from exc


class SidecarSession:
    """State of one sidecar process: the open document, its page cache, request handling.

    A session lives for the whole process, so every open document must be paired
    with closing the previous extractor and dropping every cached page — cached
    pages belong to the file they were extracted from and must never be served
    for another document.
    """

    def __init__(
        self,
        cache: Optional[PageCache] = None,
        extractor_factory: Callable[..., PdfExtractor] = PdfExtractor,
    ):
        self._cache = cache if cache is not None else PageCache(max_pages=10)
        self._extractor_factory = extractor_factory
        self._extractor: Optional[PdfExtractor] = None
        # Set once a shutdown request has been handled so main() can stop looping.
        self.should_exit = False

    @property
    def cache(self) -> PageCache:
        return self._cache

    @property
    def extractor(self) -> Optional[PdfExtractor]:
        return self._extractor

    def close_extractor(self) -> None:
        """Close the current document (if any) and forget it."""
        extractor, self._extractor = self._extractor, None
        if extractor is None:
            return
        try:
            extractor.close()
        except Exception as e:
            # A failing close must never break the session or the protocol.
            sys.stderr.write(f'Error closing PDF: {e}\n')
            sys.stderr.flush()

    def handle(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
        request_id: int = 0,
        progress: Optional[Callable[[dict[str, Any]], None]] = None,
    ) -> dict[str, Any]:
        """Handle one request and return the response dict ({'id', 'result'} / {'id', 'error'}).

        ``progress`` is forwarded to methods that report incremental work (only
        ``diff_documents`` today); every other method ignores it.
        """
        params = params or {}
        try:
            result = self._dispatch(method, params, progress)
        except RpcError as e:
            return {'id': request_id, 'error': str(e)}
        except Exception as e:
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            return {'id': request_id, 'error': str(e)}
        return {'id': request_id, 'result': result}

    def _dispatch(
        self,
        method: str,
        params: dict[str, Any],
        progress: Optional[Callable[[dict[str, Any]], None]] = None,
    ) -> Any:
        if method == 'open':
            return self._open(params)

        if method == 'extract_page':
            extractor = self._require_extractor()
            page_num = params['page']
            cached = self._cache.get(page_num)
            if cached is not None:
                return cached
            data = extractor.extract_page(page_num)
            self._cache.put(page_num, data)
            return data

        if method == 'extract_metadata':
            return self._require_extractor().get_metadata()

        if method == 'analyze_fonts':
            return self._require_extractor().analyze_fonts(
                params.get('start_page'), params.get('end_page')
            )

        if method == 'get_image_data':
            return self._require_extractor().get_image_data(params['stream_id'])

        if method == 'diff_documents':
            return self._diff_documents(params, progress)

        if method == 'audit_document':
            return audit_document(self._require_extractor())

        if method == 'audit_pages':
            return self._audit_pages(params)

        if method == 'security_document':
            return security_report(self._require_extractor())

        if method == 'accessibility_document':
            return accessibility_report(self._require_extractor())

        if method == 'raw_document':
            return self._raw_dispatch(raw_document)

        if method == 'raw_object':
            return self._raw_dispatch(
                raw_object, params.get('object_number'), params.get('generation')
            )

        if method == 'raw_page_content':
            return self._raw_dispatch(raw_page_content, params.get('page'))

        if method == 'shutdown':
            self.close_extractor()
            self.should_exit = True
            return {}

        raise RpcError(f'Unknown method: {method}')

    def _open(self, params: dict[str, Any]) -> dict[str, Any]:
        path = params['path']
        password = params.get('password')
        # Drop the previous document *before* opening the next one: its cached
        # pages and its open file handle belong to a different PDF.
        self.close_extractor()
        self._cache.clear()
        extractor = self._extractor_factory(path, password)
        self._extractor = extractor
        return extractor.get_metadata()

    def _diff_documents(
        self,
        params: dict[str, Any],
        progress: Optional[Callable[[dict[str, Any]], None]] = None,
    ) -> dict[str, Any]:
        """Diff two PDFs on throwaway extractors.

        Deliberately independent of the session: the current document, its page
        cache and its extractor are untouched, so a diff never changes what the
        user is inspecting. ``diff_files`` owns (and closes) its own extractors.
        ``progress`` is the transport's per-page report, used to keep a long diff
        from looking like an idle request.
        """
        old_path = params.get('old_path')
        new_path = params.get('new_path')
        for label, value in (('old_path', old_path), ('new_path', new_path)):
            if not isinstance(value, str) or not value.strip():
                raise RpcError(f'"{label}" must be a non-empty file path')

        options = _parse_diff_options(params.get('options'))
        try:
            return diff_files(old_path, new_path, options, progress)
        except (DiffError, ValueError) as exc:
            # A bad PDF or bad option values are user errors, not protocol
            # failures: report the message without a traceback.
            raise RpcError(str(exc)) from exc

    def _audit_pages(self, params: dict[str, Any]) -> dict[str, Any]:
        """Audit a 1-based inclusive page range of the open document.

        Invalid ranges (non-integer, zero, reversed or past the last page) are
        user errors: ``AuditError``/``ValueError`` become an ``RpcError`` so the
        renderer gets the message instead of a traceback.
        """
        extractor = self._require_extractor()
        try:
            return audit_pages(
                extractor, params.get('start_page'), params.get('end_page')
            )
        except (AuditError, ValueError) as exc:
            raise RpcError(str(exc)) from exc

    def _require_extractor(self) -> PdfExtractor:
        if self._extractor is None:
            raise RpcError('No PDF open')
        return self._extractor

    def _raw_dispatch(self, function: Callable[..., Any], *args: Any) -> Any:
        """Run a raw-document method on the open extractor.

        ``RawError``/``ValueError`` are user errors (bad page, object number or
        generation): they become an ``RpcError`` so the renderer gets the
        message without a traceback.
        """
        extractor = self._require_extractor()
        try:
            return function(extractor, *args)
        except (RawError, ValueError) as exc:
            raise RpcError(str(exc)) from exc


def main():
    session = SidecarSession()

    # Signal readiness to parent process — stdout must be flushed before stdin loop starts
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = parse_request(line)
        except (json.JSONDecodeError, KeyError) as e:
            sys.stderr.write(f'Parse error: {e}\n')
            sys.stderr.flush()
            continue

        # Progress is a separate stdout message ({'id', 'progress'}), written and
        # flushed as soon as the work reports it: the parent uses it to keep the
        # request's inactivity timeout alive instead of capping the total time.
        def report_progress(payload: dict[str, Any], request_id: int = req.id) -> None:
            _write_progress(request_id, payload)

        # A diff also heartbeats while one page runs long; the thread is stopped
        # and joined before the response below is written.
        response = _handle_request(session, req.method, req.params, req.id, report_progress)
        resp = format_response(RpcResponse(
            id=response['id'],
            result=response.get('result'),
            error=response.get('error'),
        ))
        _write_stdout_text(resp)

        if session.should_exit:
            break


if __name__ == '__main__':
    main()
