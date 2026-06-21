"""Move-history audit trail for conversations (between projects) and projects
(between workspaces).

A small, deliberately-redundant JSON log stored on the moved entity itself
(`conversation.move_history` / `project.move_history`): each entry records where
the item came from, where it went, who moved it, and when. Written on both the
single-move and bulk-move paths so the record is consistent regardless of how
the move was triggered. Surfaced read-only under the per-item move UI.
"""

from __future__ import annotations

from typing import Any, Optional
from datetime import datetime, timezone


def append_move_entry(
    history: Any,
    *,
    from_id: Optional[str],
    to_id: str,
    by: Optional[str],
    from_label: Optional[str] = None,
    to_label: Optional[str] = None,
    by_label: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Return `history` with one move record appended.

    `history` may be None or a non-list (legacy / unset) — treated as empty.
    `from_id`/`to_id` are the prior/new parent (project or workspace), `by` the
    app_user id who performed the move. Human-readable `*_label` fields are
    stored alongside the ids (deliberately redundant) so the history renders
    without resolving ids later.
    """
    entries: list[dict[str, Any]] = list(history) if isinstance(history, list) else []
    entries.append(
        {
            "from": from_id,
            "from_label": from_label,
            "to": to_id,
            "to_label": to_label,
            "by": by,
            "by_label": by_label,
            "at": datetime.now(timezone.utc).isoformat(),
        }
    )
    return entries
