"""The product documentation as a small read-only file system.

Same corpus, same three verbs the in-app assistant has (list, line-numbered
read, regex grep), served from the server so an agent over MCP reads what a
host reads. Deployed environments fetch the published site (docs.dembrane.com
lists every page in llms.txt and serves a markdown twin per page); local
runs read the repository's docs folder. The corpus is cached for an hour.
"""

from __future__ import annotations

import re
import json
import time
import asyncio
import hashlib
from typing import Any, Optional
from logging import getLogger
from pathlib import Path

import httpx

from dembrane.redis_async import get_redis_client
from dembrane.agentic_client import docs_base_url_for_env

logger = getLogger("dembrane.knowledge")

MAX_READ_LINES = 400
MAX_GREP_RESULTS = 50
CORPUS_TTL_SECONDS = 3600
_FETCH_CONCURRENCY = 8

_memo: dict[str, tuple[float, dict[str, str]]] = {}
_lock = asyncio.Lock()


def _repo_docs_dir() -> Optional[Path]:
    # server/dembrane/knowledge.py → repo root is three levels up; docs/ lives there.
    candidate = Path(__file__).resolve().parents[3] / "docs"
    return candidate if candidate.is_dir() else None


def _disk_corpus(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for p in sorted(root.rglob("*.md")):
        rel = p.relative_to(root).as_posix()
        # Published set only: no authoring notes, no translation twins.
        if rel.startswith("_authoring/") or re.search(r"\.[a-z]{2}-[A-Z]{2}\.md$", rel):
            continue
        out[rel] = p.read_text(encoding="utf-8", errors="replace")
    return out


async def _published_corpus(base: str) -> dict[str, str]:
    async with httpx.AsyncClient(timeout=20) as client:
        index = (await client.get(f"{base}/llms.txt")).text
        paths = re.findall(rf"\({re.escape(base)}/([^)\s]+\.md)\)", index)
        sem = asyncio.Semaphore(_FETCH_CONCURRENCY)

        async def fetch(path: str) -> tuple[str, str]:
            async with sem:
                r = await client.get(f"{base}/{path}")
                return path, (r.text if r.status_code == 200 else "")

        pages = await asyncio.gather(*(fetch(p) for p in dict.fromkeys(paths)))
    return {p: t for p, t in pages if t}


async def corpus() -> dict[str, str]:
    """{path: markdown}. Memoised per process, shared through Redis, so a
    grep never costs 91 HTTP calls twice in an hour."""
    base = docs_base_url_for_env().rstrip("/")
    key = "disk" if not base else hashlib.sha1(base.encode()).hexdigest()[:12]
    hit = _memo.get(key)
    if hit and time.time() - hit[0] < CORPUS_TTL_SECONDS:
        return hit[1]
    async with _lock:
        hit = _memo.get(key)
        if hit and time.time() - hit[0] < CORPUS_TTL_SECONDS:
            return hit[1]
        data: dict[str, str] = {}
        if not base:
            root = _repo_docs_dir()
            data = _disk_corpus(root) if root else {}
        else:
            redis_key = f"dembrane:knowledge:{key}"
            try:
                client = await get_redis_client()
                raw = await client.get(redis_key)
                if raw:
                    data = json.loads(raw)
            except Exception as exc:  # noqa: BLE001 — cache miss is not an error
                logger.debug("knowledge cache read failed: %s", exc)
            if not data:
                try:
                    data = await _published_corpus(base)
                except Exception as exc:  # noqa: BLE001 — degrade to empty, never raise
                    logger.warning("knowledge corpus fetch failed from %s: %s", base, exc)
                    data = {}
                if data:
                    try:
                        client = await get_redis_client()
                        await client.set(redis_key, json.dumps(data), ex=CORPUS_TTL_SECONDS)
                    except Exception as exc:  # noqa: BLE001
                        logger.debug("knowledge cache write failed: %s", exc)
        _memo[key] = (time.time(), data)
        return data


def _title(text: str, path: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return path


async def list_docs() -> list[dict[str, str]]:
    data = await corpus()
    return [{"path": p, "title": _title(t, p)} for p, t in sorted(data.items())]


async def read_doc(path: str, offset: int = 1, limit: int = MAX_READ_LINES) -> str:
    data = await corpus()
    text = data.get(path.strip().lstrip("/"))
    if text is None:
        return f"Not found: {path}. Use list_docs to see available paths."
    lines = text.splitlines()
    start = max(offset, 1)
    end = min(start - 1 + max(1, min(limit, MAX_READ_LINES)), len(lines))
    numbered = [f"{i}: {lines[i - 1]}" for i in range(start, end + 1)]
    suffix = (
        ""
        if end >= len(lines)
        else f"\n... ({len(lines) - end} more lines; call read_doc with offset={end + 1})"
    )
    return "\n".join(numbered) + suffix


async def grep_docs(pattern: str, max_results: int = MAX_GREP_RESULTS) -> list[dict[str, Any]]:
    data = await corpus()
    try:
        compiled = re.compile(pattern, re.IGNORECASE)
    except re.error:
        compiled = re.compile(re.escape(pattern), re.IGNORECASE)
    cap = max(1, min(max_results, MAX_GREP_RESULTS))
    results: list[dict[str, Any]] = []
    for path, text in sorted(data.items()):
        for lineno, line in enumerate(text.splitlines(), start=1):
            if compiled.search(line):
                results.append({"path": path, "line": lineno, "text": line.strip()[:300]})
                if len(results) >= cap:
                    return results
    return results
