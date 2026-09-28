/**
 * Agent access: an OAuth 2.1 authorisation server plus an MCP server that act as one
 * dembrane user. An agent registers as a client, the person approves it on the dashboard's
 * consent page, and the tokens it receives are bound to a grant naming the organisations
 * and scopes the person allowed. Every call resolves the grant back to that person and
 * runs through the same access rules the dashboard uses.
 *
 * These values are part of the wire contract with clients already connected through the
 * Python API (token prefixes, lifetimes, scopes), so changing one is a breaking change.
 */

export const SCOPE_READ = "read";
export const SCOPE_WRITE = "write";
export const VALID_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

/** Bumped whenever the risk notice on the consent page changes; stored on each grant. */
export const CONSENT_VERSION = "2026-09-06";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTH_CODE_TTL_SECONDS = 5 * 60;
export const AUTHORIZE_REQUEST_TTL_SECONDS = 10 * 60;
export const GRANT_EXPIRY_CHOICES_DAYS = [30, 90, 365] as const;

/** Free organisations get this many tool calls per calendar month; paid ones are not counted. */
export const FREE_TIER_MONTHLY_CALLS = 1000;

export const TOKEN_PREFIX_ACCESS = "dbr_at_";
export const TOKEN_PREFIX_REFRESH = "dbr_rt_";

/** The MCP endpoint and the OAuth issuer share this path; the OAuth endpoints sit under it. */
export const MCP_PATH = "/api/mcp";
/** The dashboard page that shows the consent screen for a parked authorisation request. */
export const CONSENT_PATH = "/settings/agents/authorize";

/** What the consent page and the "Connect your agent" page show for one MCP server. */
export interface ServerDescriptor {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly data_reach: readonly string[];
  readonly can_change: readonly string[];
  readonly tools: readonly string[];
}

export const USER_SERVER: ServerDescriptor = {
  id: "user",
  name: "dembrane MCP",
  summary:
    "Lets an AI agent read the conversations, transcripts and projects you " +
    "can already see, in the organisations you pick. It acts as you.",
  data_reach: [
    "Organisations, workspaces and projects you are a member of",
    "Conversation details, summaries and full transcripts",
  ],
  can_change: ["Project settings, with the write scope"],
  tools: [
    "dembrane_whoami",
    "dembrane_find_projects",
    "dembrane_get_project",
    "dembrane_update_project",
    "dembrane_list_conversations",
    "dembrane_search_transcripts",
    "dembrane_grep_conversation",
    "dembrane_read_transcript",
    "dembrane_get_conversation",
    "dembrane_list_project_webhooks",
    "dembrane_report_issue",
    "dembrane_request_tool",
    "dembrane_read_doc",
    "dembrane_search_docs",
    "dembrane_list_tools",
  ],
};

export const SERVERS: readonly ServerDescriptor[] = [USER_SERVER];
