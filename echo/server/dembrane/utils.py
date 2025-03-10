import time
import uuid
import random
import asyncio
import logging
import threading
from typing import Any, Dict, Tuple, Optional, Generator
from datetime import datetime, timezone

random.seed(time.time())


def generate_uuid() -> str:
    return str(uuid.uuid4())


def generate_4_digit_pin() -> str:
    return str(random.randint(1000, 9999))[:4]


def generate_6_digit_pin() -> str:
    return str(random.randint(100000, 999999))[:6]


def iter_file_content(file_path: str) -> Generator[bytes, None, None]:
    with open(file_path, mode="rb") as file_like:
        yield from file_like


def run_with_timeout(func, args=(), kwargs=None, timeout_sec: int = 1000):  # type: ignore
    if kwargs is None:
        kwargs = {}

    def timeout_handler() -> None:
        raise TimeoutError("Function execution timed out")

    timer = threading.Timer(timeout_sec, timeout_handler)
    timer.start()

    try:
        result = func(*args, **kwargs)  # noqa
        timer.cancel()
        return result
    except Exception as e:
        timer.cancel()
        raise e


def get_utc_timestamp() -> datetime:
    return datetime.now(tz=timezone.utc)


def get_safe_filename(filename: str) -> str:
    return filename.replace("/", "_").replace("\\", "_").replace(" ", "_")


logger = logging.getLogger(__name__)


class CacheWithExpiration:
    def __init__(self, ttl: int):
        self.cache: Dict[str, Tuple[Any, float]] = {}
        self.ttl = ttl
        self.lock = asyncio.Lock()
        logger.debug(f"Initialized CacheWithExpiration with TTL: {ttl}")

    async def get(self, key: str) -> Optional[Any]:
        async with self.lock:
            if key in self.cache:
                value, expiration_time = self.cache[key]
                if time.time() < expiration_time:
                    logger.debug(f"Cache hit for key: {key}")
                    return value
                else:
                    logger.debug(f"Cache expired for key: {key}")
                    del self.cache[key]
            else:
                logger.debug(f"Cache miss for key: {key}")
        return None

    async def set(self, key: str, value: Any) -> None:
        expiration_time = time.time() + self.ttl
        async with self.lock:
            self.cache[key] = (value, expiration_time)
        logger.debug(f"Set cache for key: {key}, expires at: {expiration_time}")
        asyncio.create_task(self.expire_cache(key, expiration_time))

    async def expire_cache(self, key: str, expiration_time: float) -> None:
        await asyncio.sleep(self.ttl)
        async with self.lock:
            stored_value = self.cache.get(key)
            if stored_value and stored_value[1] <= expiration_time:
                del self.cache[key]
                logger.debug(f"Expired and removed cache for key: {key}")

    async def clear(self) -> None:
        async with self.lock:
            self.cache.clear()
            logger.debug("Cleared entire cache")
