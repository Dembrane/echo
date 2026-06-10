# AGENTS: frontend

Cross-cutting rules (brand, UI, Directus, BFF, architecture, translations) live in @../AGENTS.md, which also defines the maintenance protocol for these files. This file only adds frontend-specific patterns and non-obvious gotchas.

## Patterns

- **React Query hook hubs**: each feature owns a `hooks/index.ts` exposing `useQuery`/`useMutation` wrappers with shared `useQueryClient` invalidation. See `src/components/{conversation,project,chat,participant,...}/hooks/index.ts`
- **Lingui macros**: routed screens import `t` from `@lingui/core/macro` and `Trans` from `@lingui/react/macro`, not the runtime imports
- **Mantine + Tailwind blend**: compose with Mantine primitives (`Stack`, `Group`, `ActionIcon`) and layer Tailwind utility classes via `className` on the same element
- **Custom Directus POSTs** (e.g. 2FA) use `directus.request` with a function signature, not `restRequest`. Reuse `postDirectus` from `src/components/settings/hooks/index.ts`
- **Auth session state** lives under the `['auth','session']` React Query key. Invalidate it on login/logout before fetching `['users','me']`
- **2FA flow**: Directus surfaces it by returning `INVALID_OTP`. Toggle a Mantine `PinInput` field and retry the same mutation. See `src/routes/auth/Login.tsx`
- **Transitions**: login/logout flows call `useTransitionCurtain().runTransition()` before navigation; animations expect the Directus mutation promise to be awaited

## Buttons and brand colors

The Mantine theme (`src/theme.tsx`) already sets `<Button>` defaults to `color="primary"` and `variant="filled"`. Most buttons need zero props beyond children.

```tsx
// Correct: theme handles color + filled variant
<Button onClick={onSave}>Save</Button>

// Correct: explicit outline / subtle when needed
<Button variant="outline" onClick={onCancel}>Cancel</Button>
<Button variant="subtle" onClick={onSkip}>Skip</Button>

// Wrong: variant="default" is the off-brand gray Mantine default
<Button variant="default">Cancel</Button>

// Wrong: color="blue" is raw Mantine blue, not brand Royal Blue
<Button color="blue">Save</Button>
<Alert color="blue" variant="light">...</Alert>
```

Rules:

- Allowed `Button` / `ActionIcon` variants: omit (filled), `"outline"`, `"subtle"`. `"light"` only when nothing else fits
- Allowed colors: `"primary"` (or omit), `"red"` for destructive, brand accent keys from `src/colors.ts`. Never `"blue"`
- Don't hardcode hex colors in components. Use Mantine color tokens or Tailwind classes from the theme
- The Royal Blue brand color **is** `color="primary"`. There is no reason to ever pass `color="blue"`

## Sidebar Navigation

- The sketch is canonical for the first-layer sidebar: Search and Inbox live at the top; Home and Organisations are the primary body; user-level settings sits directly below organisations; Help is an expanded footer utility list, not a pushed view.
- Bottom footer actions must not change the top sidebar context. Scope changes should come from body rows like organisations, workspaces, projects, inbox, or user settings.
- User settings are global. Organisation, workspace, and project settings stay inside their scope views.
- Do not link to `status.dembrane.com` until a status surface exists. The future status page should cover queue depth and backend health.

## Analytics (PostHog)

PostHog is the only analytics tool (Plausible was migrated and removed). Pageviews, including SPA history changes, come from the `defaults` option in `posthog.init`; never add a pageview tracker.

- `posthog-js` + `@posthog/react` are initialized in `src/main.tsx`; the app is wrapped in `PostHogProvider`
- Call `posthog.identify(email)` on login and registration, `posthog.reset()` on logout. Never identify by Directus user id
- Event naming: `snake_case` past-tense verb (`user_logged_in`, `project_created`, `chat_message_sent`). Prefer one event with a property over near-duplicate events (`contact_sales_clicked` with `source`, not two events)
- Funnel pairs are intentional; keep both ends when touching a flow: `workspace_request_started` -> `workspace_request_submitted`, `$pageview` -> `registration_details_completed` -> `user_registered`, `select_all_clicked` -> `select_all_confirmed` -> `select_all_completed`/`select_all_failed`
- Grep for `posthog.capture(` to see the live event set; auth, project, chat, report, conversation, and workspace-request flows are covered
- Dashboard + insights live in the PostHog EU projects (production id 160282, echo-next id 197841). Don't add new dashboards from code; wire the event and let analytics own the visualization
- One-off error reports use `posthog.captureException`, not a capture event (see `ErrorBoundary`, participant audio interruption)

## Modal conventions

- `ConfirmModal` / `InputModal` already handle button layout (subtle cancel left, primary right)
- Use kebab-case `data-testid` on modals (`"chat-delete-modal"`); the components auto-append `-cancel` / `-confirm` to the buttons
- Manage open/close with `useDisclosure` from `@mantine/hooks`

## Dynamic theming

Theme is driven by CSS variables, not Tailwind tokens, so `dark:` classes don't propagate. Use the variables when colors need to follow the active theme.

- Variables defined in `src/index.css`, updated at runtime by `src/hooks/useAppPreferences.tsx`:
  - `--app-background`: page/component background
  - `--app-text`: default text color
  - `--app-font-family`: font family
- Font preference is **linked** to a color scheme; switching font also switches the palette:
  - DM Sans → Parchment `#F6F4F1` background + Graphite `#2D2D2C` text
  - Space Grotesk → White background + Black text
- Mantine theme (`src/theme.tsx`) overrides `white` and `black` and pins Modal/Drawer/Popover backgrounds to `var(--app-background)`
- For Tailwind classes that need theme values, replace with inline `style`:
  ```tsx
  // Instead of: className="bg-parchment"
  style={{ backgroundColor: "var(--app-background)" }}
  ```
- User preferences persist in `localStorage` under `dembrane-app-preferences`

## Mode-specific colors (intentionally hardcoded)

Chat mode accents are theme-independent (consistent identification across themes), defined in `src/components/chat/ChatModeSelector.tsx` `MODE_COLORS`:

- Overview: Spring Green `#1EFFA1`
- Deep Dive: Cyan `#00FFFF`

## Local dev gotchas

- No env vars, locally or on Vercel. Base URLs, feature flags, PostHog, and router selection all resolve in code per environment (`src/config.ts`, `byEnv()` keyed on hostname). Only `VITE_DEBUG_MODE` and the `VITE_ENABLE_AGENTATION=0` build escape hatch remain
- The participant subtree has its own dev server via `pnpm participant:dev`; the participant router activates on `portal.*` hostnames or local port 5174
