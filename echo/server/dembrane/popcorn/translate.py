"""Results in another language, on the host's request.

The deck shows the room's words in the language they were spoken. A host can
ask for one other language for the presentation; the tick then translates
every text the room's bundle shows and keeps each translation under a key of
its source text, so a text is translated once however often the deck is
rebuilt, and a rerun or a Library edit only costs the texts that changed. The
bundle swaps the texts as its last step, after published objects are applied,
so what is translated is what the room would otherwise read.

A host can stack more languages on top of that one. The extra languages are
for the popcorn phrases alone: every phrase pops in the room's own words
first, then in each language the host asked for. Everything else on the deck
keeps to the first language.
"""

from __future__ import annotations

import hashlib
from typing import Any, Callable

LANGUAGES = ("en", "nl", "de", "fr", "es", "it", "uk", "cs")
TRANSLATION_POLICY_VERSION = "popcorn-room-v2"

# The fields of each file that carry analysis text. Names typed on phones and
# conversation labels are not results and stay as they are.
_TENSION_FIELDS = ("poleA", "poleB", "knot", "narrative", "toResolve")
_STAKEHOLDER_FIELDS = ("name", "role", "stake")
_RELATION_FIELDS = ("label", "detail")


def text_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]


def cache_key(
    text: str, target: str, policy: str = TRANSLATION_POLICY_VERSION
) -> str:
    """A reusable translation key whose policy can change without stale reuse."""
    value = f"{policy}\x1f{target}\x1f{text}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


def _swap(entry: Any, fields: tuple[str, ...], fn: Callable[[str], str]) -> Any:
    if not isinstance(entry, dict):
        return entry
    out = dict(entry)
    for field in fields:
        if isinstance(out.get(field), str) and out[field].strip():
            out[field] = fn(out[field])
    return out


def _map_files(files: dict[str, Any], fn: Callable[[str], str]) -> dict[str, Any]:
    out = dict(files)
    for name, file in files.items():
        if not isinstance(file, dict):
            continue
        if name.startswith("popcorn/"):
            out[name] = {
                **file,
                "items": [_swap(i, ("phrase",), fn) for i in file.get("items") or []],
            }
        elif name == "quotes.json":
            out[name] = {
                **file,
                "quotes": [_swap(q, ("text",), fn) for q in file.get("quotes") or []],
            }
        elif name == "tensions.json":
            out[name] = {
                **file,
                "tensions": [_swap(t, _TENSION_FIELDS, fn) for t in file.get("tensions") or []],
            }
        elif name == "stakeholders.json":
            people = []
            for person in file.get("stakeholders") or []:
                person = _swap(person, _STAKEHOLDER_FIELDS, fn)
                if isinstance(person, dict) and isinstance(person.get("evidence"), dict):
                    person["evidence"] = _swap(person["evidence"], ("note",), fn)
                people.append(person)
            relations = []
            for relation in file.get("relations") or []:
                relation = _swap(relation, _RELATION_FIELDS, fn)
                if isinstance(relation, dict):
                    relation["aspects"] = [
                        _swap(a, ("note",), fn) for a in relation.get("aspects") or []
                    ]
                relations.append(relation)
            out[name] = {**file, "stakeholders": people, "relations": relations}
    return out


def translatable_texts(files: dict[str, Any]) -> list[str]:
    """Every distinct text the room's deck shows, in first-seen order."""
    seen: dict[str, None] = {}

    def note(text: str) -> str:
        seen.setdefault(text, None)
        return text

    _map_files(files, note)
    return list(seen)


def popcorn_texts(files: dict[str, Any]) -> list[str]:
    """Every distinct popcorn phrase on the deck, in first-seen order.
    What an extra language translates, and nothing else."""
    return translatable_texts(
        {name: file for name, file in files.items() if name.startswith("popcorn/")}
    )


def missing_texts(
    files: dict[str, Any],
    table: dict[str, str],
    target: str = "",
    texts: list[str] | None = None,
) -> list[str]:
    """What `table` still owes, over the whole deck or over `texts` alone."""
    key = (lambda text: cache_key(text, target)) if target else text_key
    wanted = translatable_texts(files) if texts is None else texts
    return [text for text in wanted if key(text) not in table]


def target_language(settings: dict[str, Any]) -> str:
    return str((settings.get("language") or {}).get("translate_to") or "")


def target_languages(settings: dict[str, Any]) -> list[str]:
    """Every language the results are translated into: the one that carries the
    whole deck first, then the extra popcorn languages in the host's order."""
    primary = target_language(settings)
    if not primary:
        return []
    also = (settings.get("language") or {}).get("also")
    extra = [
        code
        for code in (also if isinstance(also, list) else [])
        if code in LANGUAGES and code != primary
    ]
    return [primary, *dict.fromkeys(extra)]


def translated_bundle(
    bundle: dict[str, Any], state: dict[str, Any], settings: dict[str, Any]
) -> dict[str, Any]:
    """`bundle` in the host's chosen language, as far as the tick has got.
    A text not translated yet shows in its original; the session says how
    many are still on their way."""
    targets = target_languages(settings)
    files = bundle.get("files")
    if not targets or not isinstance(files, dict):
        return bundle
    target = targets[0]
    tables = {code: ((state.get("translations") or {}).get(code)) or {} for code in targets}
    table = tables[target]

    def translated_text(text: str) -> str:
        return table.get(cache_key(text, target), text)

    # Popcorn keeps its source wording and identity. The browser owns the
    # original-first handoff; replacing `phrase` here used to make that
    # impossible when a warm cache answered before the phrase reached stage.
    translated = _map_files(files, translated_text)
    for name, file in files.items():
        if not name.startswith("popcorn/") or not isinstance(file, dict):
            continue
        items = []
        for item in file.get("items") or []:
            if not isinstance(item, dict):
                items.append(item)
                continue
            source = item.get("phrase")
            # Every language the host asked for, in their order, so the deck
            # can pop the original and then each answer in turn.
            stack: list[dict[str, str]] = []
            for code in targets if isinstance(source, str) else []:
                found = tables[code].get(cache_key(source, code))
                if found and found != source:
                    stack.append({"language": code, "text": found})
            answer = stack[0]["text"] if stack and stack[0]["language"] == target else None
            out = dict(item)
            if stack:
                out["translations"] = stack
            if answer and answer != source:
                out["translation"] = answer
                out["translation_language"] = target
                out["translation_policy"] = TRANSLATION_POLICY_VERSION
                out["translation_ref"] = {
                    "source_key": text_key(str(source)),
                    "item_id": str(item.get("id") or ""),
                    "revision": file.get("revision"),
                }
            items.append(out)
        translated[name] = {**file, "items": items}
    session = translated.get("session.json")
    if isinstance(session, dict):
        phrases = popcorn_texts(files)
        pending = len(missing_texts(files, table, target))
        for code in targets[1:]:
            pending += len(missing_texts(files, tables[code], code, phrases))
        translated["session.json"] = {
            **session,
            "translation": {
                "to": target,
                "also": targets[1:],
                "policy": TRANSLATION_POLICY_VERSION,
                "pending": pending,
            },
        }
    return {**bundle, "files": translated}
