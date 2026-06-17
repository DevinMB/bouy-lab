import threading
import time
from typing import Any, Callable


class TTLCache:
    def __init__(self, ttl_seconds: int = 60):
        self._ttl = ttl_seconds
        self._store: dict[str, tuple] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Any:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            value, expires_at = entry
            if time.monotonic() > expires_at:
                del self._store[key]
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._store[key] = (value, time.monotonic() + self._ttl)

    def get_or_set(self, key: str, factory: Callable) -> Any:
        cached = self.get(key)
        if cached is not None:
            return cached
        with self._lock:
            # Double-check after acquiring lock
            entry = self._store.get(key)
            if entry is not None:
                value, expires_at = entry
                if time.monotonic() <= expires_at:
                    return value
            value = factory()
            self._store[key] = (value, time.monotonic() + self._ttl)
            return value

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)


snapshot_cache = TTLCache(ttl_seconds=60)
