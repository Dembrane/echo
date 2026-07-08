# Brief: Wave 9 - the agent must hand hosts the real portal link, never invented navigation

Owner feedback from real usage. The agent told a host: "Find your Portal Link:
In your dembrane dashboard, look for the Portal tab or link." There is NO
Portal tab. The portal link and QR code live on the project Overview page
(ProjectHomeRoute renders PortalSettingsOverview + the QR block) and on the
Host guide page. The agent invented UI navigation because it has no access to
the real link. Branch: sameer/agent-portal-link. Read echo/agent/agent.py
prompt + tools and echo/agent/AGENTS.md first.

## The experience we want

When a host asks how participants record (or the agent reaches the "share the
portal" step of setup), the agent pastes the ACTUAL portal link for this
project, ready to forward, and mentions where it lives in the dashboard for
later: "you'll also find this link and a QR code on your project's overview
page, and the host guide walks through sharing it." No hunting, no fictional
tabs.

## Facts (verified in code)

- Share-link shape: `{PARTICIPANT_BASE_URL}/{language}/{project_id}/start`
  (echo/frontend/src/components/project/ProjectQRCode.tsx:79).
- PARTICIPANT_BASE_URL per env (echo/frontend/src/config.ts): portal.* sibling
  of the dashboard.* host, e.g. https://portal.echo-next.dembrane.com for
  echo-next, https://portal.dembrane.com for production. Local dev participant
  server is port 5174.
- The language segment is the project's language code (the same value
  getProjectSettings already returns, e.g. "en", "nl").
- Real dashboard surfaces the agent may reference (project sidebar): Overview
  (has the portal link + QR + portal settings summary + Portal editor button),
  Chats, Monitor, Library, Host guide, Report, Conversations, Settings.

## Tasks

1. AGENT: give the agent the real link (echo/agent). Either add a small
   `getPortalLink` tool or fold a `portal_link` field into getProjectSettings'
   return - pick the cleaner fit with the existing tool design and justify in
   the report. The portal base URL must be derived per environment in code
   (config-in-code byEnv style: derive portal.* from the configured echo/api
   base or an explicit small mapping; NO new required env var - see the repo
   convention that derivable per-env values live in code). Cover echo-next,
   production, testing, and local dev.
2. PROMPT: add a short "## The dashboard" section listing the real surfaces
   (names above) with one clause each on what lives there, and the rule: never
   describe dashboard navigation beyond these surfaces; when sharing the
   portal is the topic, give the actual link via the tool and point at
   Overview / Host guide as the durable home of link + QR. Never invent tabs,
   buttons, or menus.
3. SKILL: project-onboarding.md step 5 mentions "sharing the portal link" -
   align it: the agent shares the link itself (tool), and mentions Overview /
   Host guide.
4. TESTS: agent pytest - tool returns the right link shape per env (unit-test
   the URL builder with mocked settings), prompt assertions for the new
   section. Update any assertions broken by wording changes.

## Gotchas

- The agent service knows which env it's in via its existing settings/base
  URLs - reuse that, don't sniff hostnames at request time.
- Language may be unset/"default": fall back to "en" in the link rather than
  emitting a literal "default" segment.
- Brand voice in examples: lowercase dembrane, no "AI", no em dashes.

QA: agent `uv run pytest -q` green; then LIVE check against echo-next is not
possible until deploy, so instead run the agent locally if the harness allows,
or at minimum show the tool's return value for a fake project in each env
mapping via a unit test. No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave9-REPORT.md.
