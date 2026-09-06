"""One writer for support_request rows, whoever files them.

Three callers, one shape: the dashboard's report form, the in-app assistant's
reachOutToDembraneSupport, and an agent connected over MCP. `source` says
which; the forwarder carries every row to the team the same way.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from dembrane.directus_async import async_directus

SOURCE_DASHBOARD = "dashboard"
SOURCE_ASSISTANT = "assistant"
SOURCE_AGENT_MCP = "agent_mcp"


async def file_support_request(
    *,
    source: str,
    message: str,
    directus_user_id: Optional[str] = None,
    app_user_id: Optional[str] = None,
    workspace_id: Optional[str] = None,
    project_id: Optional[str] = None,
    chat_id: Optional[str] = None,
    message_id: Optional[str] = None,
    page_context: str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create one row with status new. Returns the created row. Never put
    transcript content in `message` or `page_context`: the forwarder sends
    both to Slack."""
    if isinstance(page_context, dict):
        page_context = json.dumps(page_context)
    created = await async_directus.create_item(
        "support_request",
        {
            "source": source,
            "directus_user_id": directus_user_id,
            "app_user_id": app_user_id,
            "workspace_id": workspace_id,
            "project_id": project_id,
            "chat_id": chat_id,
            "message_id": message_id,
            "message": message,
            "page_context": page_context,
            "status": "new",
        },
    )
    row = created.get("data") if isinstance(created, dict) and "data" in created else created
    return row if isinstance(row, dict) else {}
