#!/usr/bin/env python3
import sys
import json
import traceback
from typing import Any, Callable, Optional

from models import parse_request, format_response, RpcResponse
from extractor import PdfExtractor
from cache import PageCache


class RpcError(Exception):
    """Protocol-level error: reported to the parent without a traceback."""


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
    ) -> dict[str, Any]:
        """Handle one request and return the response dict ({'id', 'result'} / {'id', 'error'})."""
        params = params or {}
        try:
            result = self._dispatch(method, params)
        except RpcError as e:
            return {'id': request_id, 'error': str(e)}
        except Exception as e:
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            return {'id': request_id, 'error': str(e)}
        return {'id': request_id, 'result': result}

    def _dispatch(self, method: str, params: dict[str, Any]) -> Any:
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
            return self._require_extractor().analyze_fonts()

        if method == 'get_image_data':
            return self._require_extractor().get_image_data(params['stream_id'])

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

    def _require_extractor(self) -> PdfExtractor:
        if self._extractor is None:
            raise RpcError('No PDF open')
        return self._extractor


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

        response = session.handle(req.method, req.params, req.id)
        resp = format_response(RpcResponse(
            id=response['id'],
            result=response.get('result'),
            error=response.get('error'),
        ))
        sys.stdout.write(resp)
        sys.stdout.flush()

        if session.should_exit:
            break


if __name__ == '__main__':
    main()
