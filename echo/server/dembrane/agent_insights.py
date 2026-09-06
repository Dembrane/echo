"""One writer for agent_insight rows: the product-learning channel.

The in-app assistant drafts an insight for the host to review before it is
sent; an agent over MCP files a capability gap directly, because it is the
agent's own observation, not the host's. Both land in the same table with
the same kinds, so one review surface serves both.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from dembrane.directus_async import async_directus
from dembrane.support_requests import SOURCE_AGENT_MCP, SOURCE_ASSISTANT

InsightKind = Literal["capability_gap", "friction", "wish", "praise"]

__all__ = ["InsightKind", "SOURCE_AGENT_MCP", "SOURCE_ASSISTANT", "file_agent_insight"]


async def file_agent_insight(
    *,
    source: str,
    kind: InsightKind,
    content: str,
    suggested_capability: Optional[str] = None,
    workspace_id: Optional[str] = None,
    project_id: Optional[str] = None,
    chat_id: Optional[str] = None,
    message_id: Optional[str] = None,
) -> dict[str, Any]:
    created = await async_directus.create_item(
        "agent_insight",
        {
            "source": source,
            "workspace_id": workspace_id,
            "project_id": project_id,
            "chat_id": chat_id,
            "message_id": message_id,
            "kind": kind,
            "content": content.strip(),
            "suggested_capability": (suggested_capability or "").strip() or None,
            "status": "new",
        },
    )
    row = created.get("data") if isinstance(created, dict) and "data" in created else created
    return row if isinstance(row, dict) else {}
