# portal-prototypes/v1: a host's settings page for a project

The start of a new participant portal, with a page where a host changes an Echo project's settings. The URLs follow the portal's, `/:language?/:projectId/:page?`:

| URL | Shows |
| --- | --- |
| `/en-US/<projectId>` | Hosts (signed in on the dashboard, with access to the project) get a choice: take part, or manage the project. Anyone else is sent on to `/start`. |
| `/en-US/<projectId>/start` | The participant portal. For now it's a "not yet implemented" placeholder. |
| `/en-US/<projectId>/host` | The project's settings. |

Signing in on the dashboard is enough to use it. It's a Cloudflare Worker with a Vite + React page in Cloudflare's [Kumo](https://www.npmjs.com/package/@cloudflare/kumo) theme, laid out like the examples in `dembrane/cloudflare-examples`.

## Run it

You need the dembrane API on `:8080` and the dashboard on `:5173`, as usual.

1. Sign in on the dashboard at http://localhost:5173.
2. Start this app:
   ```sh
   pnpm install
   pnpm dev
   ```
3. Open http://localhost:8804/en-US/<projectId>.

To point it at another API, such as the remote dev VM's, copy `.dev.vars.example` to `.dev.vars`. `VITE_DEV_API_PROXY` has the same name and default as in the dashboard's `vite.config.ts`.

## How signing in works

- **The dashboard's session cookie reaches this app.**
  - The dashboard's session cookie is set for `localhost`, and browsers ignore the port for cookies.
  - So a page on `localhost:8804` sends the same cookie the dashboard does.
- **No change to the platform is needed.**
  - The Worker passes `/api/auth/*` through to the API, so the page can check its session same-origin, as the dashboard's Vite proxy lets it.
  - Every other call goes from the Worker to the API with that cookie.
  - So the API doesn't need a new CORS origin.
- **Off localhost:**
  - The app needs to share a parent domain with the API (`AUTH_COOKIE_DOMAIN`).
  - Its origin also has to be the API's `PORTAL_URL`, or be added next to it.

## How settings are saved

```text
BROWSER   /en-US/<projectId>/host ──── GET / PATCH /api/projects/:id/config
                                          │  (with the dashboard cookie)
WORKER    Hono: checks the session ───────┤
                                          ▼
DURABLE   ProjectConfig "<projectId>"   SQLite: each field's value, the API's value,
OBJECT                                  and whether it's pending
                                          │  GET  /api/v2/projects/:id/bff
                                          ▼  PATCH /api/v2/bff/projects/:id
API       dembrane platform, as the signed-in person
```

- **Each project has a Durable Object, `ProjectConfig`.** It mirrors the project's settings. The page reads and writes the mirror, and the mirror syncs to the API.
  - **Opening the page:** the object takes the API's values. Any field still pending keeps its own value.
  - **Saving:**
    - The object stores the changes first, then sends them in one PATCH.
    - If the API refuses them, as invalid (422) or not allowed (403), they go back to the API's values, and the error shows on the page.
    - If the API can't be reached, they stay pending. They're sent the next time the same person opens or saves the page.
- **The object holds no credentials.**
  - Each call brings the caller's cookie, and asks the API before anything is kept or shown.
  - So the API's own access rules decide who can see and change a project.
  - A pending change is only ever sent with the session of whoever made it.
- **Every setting the dashboard can change is on the page.** That's every key in `PROJECT_UPDATE_FIELDS` (`dembrane/platform/packages/projects/src/projects.ts`). `src/shared/fields.ts` lists them, and the form is built from that list.

## Files

- `src/server/server.ts`: the Worker. It holds the routes and the `/api/auth/*` pass-through.
- `src/server/project.do.ts`: `ProjectConfig`, the mirror, and its sync.
- `src/server/api.ts`: the calls to the dembrane API.
- `src/shared/fields.ts`: the settings, their types and their option lists.
- `src/client/index.tsx`: picks the page from the URL.
- `src/client/pages/`: `ProjectHome.tsx` (the host's choice), `Start.tsx` (the placeholder) and `HostConfigPage.tsx` (the settings form).

## Limits

- **Pending changes:**
  - A pending change made by someone else shows as pending, but only they can send it.
  - Two hosts saving the same field at once: the last save wins, as on the dashboard.
- **Not covered:**
  - Tags, webhooks, verification topics' own texts, and the project's goal.
  - Those have their own API routes.
