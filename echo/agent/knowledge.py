"""Read-only knowledge filesystem for the agent.

v1 of the agent VFS (see echo/docs/agentic-chat-design.md): the product docs
corpus and the skill files are baked into the image (Dockerfile copies
docs/ -> /app/knowledge/docs and echo/agent/skills/ -> /app/skills). Locally
the module falls back to the repo checkout so tests and dev runs work without
a container. Per-workspace writable mounts come later; nothing here writes.
"""

import os
import re
from pathlib import Path
from typing import Any, Optional

_MAX_GREP_RESULTS = 40
_MAX_READ_LINES = 400
_SKILL_FRONTMATTER_KEYS = ("name", "description", "when_to_use")


def _first_existing(*candidates: Path) -> Optional[Path]:
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return None


def docs_root() -> Optional[Path]:
    override = os.environ.get("KNOWLEDGE_DOCS_DIR")
    if override:
        return Path(override) if Path(override).is_dir() else None
    here = Path(__file__).resolve().parent
    candidates = [here / "knowledge" / "docs"]  # container image (/app/knowledge/docs)
    if len(here.parents) >= 2:
        # repo checkout: echo/agent/knowledge.py -> <repo>/docs
        candidates.append(here.parents[1] / "docs")
    return _first_existing(*candidates)


def docs_base_url() -> str:
    """Public docs site prefix for citations, per environment (DOCS_BASE_URL,
    e.g. https://docs.echo-next.dembrane.com). Empty means the corpus is not
    published anywhere this deployment should link to; cite bare paths."""
    return os.environ.get("DOCS_BASE_URL", "").strip().rstrip("/")


def skills_root() -> Optional[Path]:
    override = os.environ.get("KNOWLEDGE_SKILLS_DIR")
    if override:
        return Path(override) if Path(override).is_dir() else None
    here = Path(__file__).resolve().parent
    return _first_existing(here / "skills")


def _resolve_inside(root: Path, relative: str) -> Path:
    resolved = (root / relative).resolve()
    if not str(resolved).startswith(str(root.resolve()) + os.sep) and resolved != root.resolve():
        raise ValueError("Path escapes the knowledge root")
    return resolved


def _iter_markdown(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*.md") if p.is_file())


def list_docs() -> list[str]:
    root = docs_root()
    if root is None:
        return []
    return [str(p.relative_to(root)) for p in _iter_markdown(root)]


def read_doc(path: str, offset: int = 1, limit: int = _MAX_READ_LINES) -> str:
    root = docs_root()
    if root is None:
        return "No documentation corpus is available in this environment."
    target = _resolve_inside(root, path)
    if not target.is_file() or target.suffix != ".md":
        return f"Not found: {path}. Use listDocs to see available paths."
    lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    start = max(offset, 1)
    end = min(start - 1 + max(1, min(limit, _MAX_READ_LINES)), len(lines))
    numbered = [f"{i}: {lines[i - 1]}" for i in range(start, end + 1)]
    if end >= len(lines):
        suffix = ""
    else:
        suffix = f"\n... ({len(lines) - end} more lines; call readDoc with offset={end + 1})"
    return "\n".join(numbered) + suffix


def grep_docs(pattern: str, max_results: int = _MAX_GREP_RESULTS) -> list[dict[str, Any]]:
    root = docs_root()
    if root is None:
        return []
    try:
        compiled = re.compile(pattern, re.IGNORECASE)
    except re.error:
        compiled = re.compile(re.escape(pattern), re.IGNORECASE)
    results: list[dict[str, Any]] = []
    for doc in _iter_markdown(root):
        rel = str(doc.relative_to(root))
        for lineno, line in enumerate(
            doc.read_text(encoding="utf-8", errors="replace").splitlines(), start=1
        ):
            if compiled.search(line):
                results.append({"path": rel, "line": lineno, "text": line.strip()[:300]})
                if len(results) >= max_results:
                    return results
    return results


def _parse_frontmatter(text: str) -> dict[str, str]:
    """Deliberately dumb single-line key: value parser (the sam pattern)."""
    meta: dict[str, str] = {}
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return meta
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    return meta


def skill_catalog() -> list[dict[str, str]]:
    root = skills_root()
    if root is None:
        return []
    catalog: list[dict[str, str]] = []
    for skill_file in _iter_markdown(root):
        meta = _parse_frontmatter(skill_file.read_text(encoding="utf-8", errors="replace"))
        if all(meta.get(key) for key in _SKILL_FRONTMATTER_KEYS):
            meta["path"] = str(skill_file.relative_to(root))
            catalog.append(meta)
    return catalog


def read_skill(path: str) -> str:
    root = skills_root()
    if root is None:
        return "No skills are available in this environment."
    target = _resolve_inside(root, path)
    if not target.is_file() or target.suffix != ".md":
        return f"Not found: {path}."
    return target.read_text(encoding="utf-8", errors="replace")


def prompt_section() -> str:
    """The knowledge block appended to the system prompt: how to use the
    docs corpus plus the skill catalog (frontmatter only, bodies lazy)."""
    parts: list[str] = []
    if docs_root() is not None:
        base = docs_base_url()
        if base:
            citation = (
                "When you cite a doc, link to its published page: drop the .md "
                f"suffix, append .html, and prefix {base}/ (so users/host/index.md "
                f"becomes {base}/users/host/index.html). Use a markdown link with "
                "a readable title, never the bare path."
            )
        else:
            citation = "Cite the doc path you used."
        parts.append(
            "You have a read-only product documentation corpus. Use grepDocs to "
            "search it and readDoc to read pages before answering questions about "
            "how dembrane works. Prefer docs over guessing. " + citation
        )
    catalog = skill_catalog()
    if catalog:
        lines = ["Available skills (read the body with readSkill when one applies):"]
        for skill in catalog:
            lines.append(
                f"- {skill['name']} ({skill['path']}): {skill['description']} "
                f"When to use: {skill['when_to_use']}"
            )
        parts.append("\n".join(lines))
    return ("\n\n" + "\n\n".join(parts)) if parts else ""
