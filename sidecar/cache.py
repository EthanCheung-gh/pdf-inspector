from collections import OrderedDict
from typing import Any, Optional


class PageCache:
    """LRU cache for extracted page data."""

    def __init__(self, max_pages: int = 10):
        self._cache: OrderedDict[int, dict[str, Any]] = OrderedDict()
        self._max_pages = max_pages

    def get(self, page_num: int) -> Optional[dict[str, Any]]:
        if page_num not in self._cache:
            return None
        self._cache.move_to_end(page_num)
        return self._cache[page_num]

    def put(self, page_num: int, data: dict[str, Any]) -> None:
        self._cache[page_num] = data
        self._cache.move_to_end(page_num)
        while len(self._cache) > self._max_pages:
            self._cache.popitem(last=False)

    def clear(self) -> None:
        self._cache.clear()
