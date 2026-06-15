"""Order-independent ("token-AND") Directus search filters.

Search should match a record when every word of the query appears in any
order, not only as one contiguous phrase: "review annual budget" must find a
project titled "Annual Budget Review". These helpers build the Directus filter
that enforces "every token present, any order, case-insensitive".

Shared by the global search endpoint (dembrane.api.search) and the
workspace-scoped project list (dembrane.api.v2.workspace_projects).
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence


def tokens(term: str) -> List[str]:
    """Split a search term into whitespace-separated tokens, dropping empties."""
    return [t for t in term.split() if t]


def all_tokens_filter(fields: Sequence[str], term: str) -> Dict[str, Any]:
    """Directus filter requiring every token of `term` to appear (in any order)
    in at least one of `fields`. Case-insensitive substring match per token.

    Shape: _and of per-token clauses; each clause is an _or over `fields`.
    Returns {} for an empty/whitespace-only term (callers guard before fetching).
    """
    toks = tokens(term)
    if not toks:
        return {}
    return {"_and": [{"_or": [{f: {"_icontains": tok}} for f in fields]} for tok in toks]}


def merge_search_filter(
    base_filter: Dict[str, Any], term: str, fields: Sequence[str] = ("name",)
) -> Dict[str, Any]:
    """AND an existing Directus filter with a token-AND search over `fields`.

    Returns `base_filter` unchanged for a blank term (no-op).
    """
    token_filter = all_tokens_filter(fields, term)
    if not token_filter:
        return base_filter
    return {"_and": [base_filter, token_filter]}
