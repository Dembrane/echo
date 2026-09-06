"""Agent access: an OAuth 2.1 authorisation server plus an MCP server that act
as one dembrane user.

An agent (Claude, Cursor, a customer's own bot) registers as an OAuth client,
sends the user to the dashboard consent page, and receives tokens bound to a
grant. The grant names the organisations and scopes the user allowed. Every
tool call resolves the grant back to the user and runs through the same
access resolvers the dashboard uses, so an agent can never see more than the
person who connected it.

Organisation admins hold a kill switch (`org.agent_access_enabled`) that is
checked on every call. Free organisations get a monthly call budget.
"""

from __future__ import annotations

from dataclasses import dataclass

SCOPE_READ = "read"
SCOPE_WRITE = "write"
VALID_SCOPES: list[str] = [SCOPE_READ, SCOPE_WRITE]

# Bumped whenever the risk notice text on the consent page changes, so a grant
# records which wording the person actually accepted.
CONSENT_VERSION = "2026-09-06"

ACCESS_TOKEN_TTL_SECONDS = 60 * 60
REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
AUTH_CODE_TTL_SECONDS = 5 * 60
AUTHORIZE_REQUEST_TTL_SECONDS = 10 * 60
GRANT_EXPIRY_CHOICES_DAYS: list[int] = [30, 90, 365]

# Free organisations: this many tool calls per calendar month. Paid orgs are
# not counted. "Paid" means at least one workspace in the org is above free.
FREE_TIER_MONTHLY_CALLS = 1000

TOKEN_PREFIX_ACCESS = "dbr_at_"
TOKEN_PREFIX_REFRESH = "dbr_rt_"


@dataclass(frozen=True)
class ServerDescriptor:
    """What the consent page and the "Connect your agent" page show for one
    MCP server. Kept as data so adding a server is one entry."""

    id: str
    name: str
    summary: str
    data_reach: list[str]
    can_change: list[str]
    tools: list[str]


USER_SERVER = ServerDescriptor(
    id="user",
    name="dembrane MCP",
    summary=(
        "Lets an AI agent read the conversations, transcripts and projects you "
        "can already see, in the organisations you pick. It acts as you."
    ),
    data_reach=[
        "Organisations, workspaces and projects you are a member of",
        "Conversation details, summaries and full transcripts",
    ],
    can_change=["Project settings, with the write scope"],
    tools=[
        "whoami",
        "list_organisations",
        "list_workspaces",
        "list_projects",
        "get_project",
        "update_project",
        "list_conversations",
        "get_conversation",
        "get_conversations",
        "list_project_webhooks",
    ],
)

SERVERS: list[ServerDescriptor] = [USER_SERVER]
