# dembrane-auth-token: a Worker outside dembrane's cookie domain, logged in by link

A minimal example of gating a Cloudflare Worker and Durable Object on a **dembrane login**, when the Worker is **outside dembrane's cookie domain** (`.dembrane.com`). The browser won't send dembrane's session cookie there, so the dashboard passes your token to the Worker in a link.

If the Worker can be inside that cookie domain, [`dembrane-auth-cookie`](../dembrane-auth-cookie) does the same thing more simply. The two differ in how the Worker gets your login:

| | [`dembrane-auth-token`](../dembrane-auth-token) (this one) | [`dembrane-auth-cookie`](../dembrane-auth-cookie) |
|---|---|---|
| **Use it when** | The Worker is **outside dembrane's cookie domain**, such as on `*.workers.dev`. That's the case today, since dembrane.com isn't on Cloudflare DNS | The Worker can be **inside dembrane's cookie domain**, `.dembrane.com`: on a hostname like `demo-cookie.dembrane.com` |
| **How the Worker learns who you are** | The dashboard puts your token in a link. The Worker keeps it in a cookie of its own | The browser sends dembrane's own session cookie. The Worker only reads it |
| **Staying logged in** | The demo goes back to the dashboard for a fresh link | The demo asks Directus to refresh the session |
| **Logging out** | Of the demo only | Of dembrane, everywhere: it's one session |
| **Accounts** | Several, with an account switcher | One per browser |
| **Open questions for production** | How the real dashboard gets a token to put in the link | Moving the dembrane.com zone to Cloudflare, and allowing the demo's origin in Directus's CORS |

The Worker verifies the same Directus JWT that dembrane's FastAPI backend already accepts, checked the same way: HS256 with `DIRECTUS_SECRET`, reading `id` and `admin_access`. It then routes each user to their own Durable Object. **dembrane's code doesn't change.**

What you'll see:

- A stand-in for the dembrane dashboard, with a link to the demo and the link's URL printed beneath it.
- A demo page where every user has a counter in their own Durable Object. You can only increment your own. Admins also see every Directus user, and can increment anyone's.
- A shared directory of users, in a single `Directory` Durable Object. Admins refresh it from Directus with **Update**, and can tick **Allow everyone to see other users**. Then everyone sees the list, though still only increments their own counter.

The Worker enforces these rules, not the page: a non-admin gets a 403 from `GET /api/users` (unless an admin allows non-admins to see other users), from `POST /api/users/refresh` and `PUT /api/settings`, and from incrementing someone else (see the curl example below).

It needs a Directus to log in to. The quickest is [`directus`](https://github.com/patcon/cloudflare-examples/tree/main/examples/directus), a local one with test accounts (see [Logging in](#logging-in)).

## Run it

```sh
../../echo/scripts/remote-dev/tunnel.sh   # in another terminal, for the VM's Directus on :8055

pnpm install
cp .dev.vars.example .dev.vars
pnpm dev                         # http://localhost:9877
```

Open <http://localhost:9877> (not 127.0.0.1: Directus allows `localhost` origins, and its cookie is for `localhost`). It redirects to `/dembrane-dashboard/`, which sends you to its login page. Each example has its own port (the cookie ones use 9878 and 9879), so you can run them side by side.

## Run it on the remote dev VM

With celld on and `./tunnel.sh` open (see [../counter/README.md](../counter/README.md)):

```sh
pnpm run deploy
```

Open http://localhost:8787 and log in as a user of the VM's Directus, such as `admin@dembrane.com` / `admin`. The VM's celld runs one app at a time, so this replaces whatever was deployed there before. The vars in `wrangler.jsonc` are the VM's values, and `.dev.vars` overrides them for `pnpm dev`.

## The flow

```
 /dembrane-dashboard/              /auth/#token=…             /demo-token/
 (pretend: dashboard.dembrane.com) (pretend: demo-token.example.com, another domain)
 ┌──────────────────────┐  click  ┌──────────────────┐       ┌─────────────────────────┐
 │ pick an account ↙    │ ──────▶ │ POST /api/session│ ────▶ │ GET  /api/users         │
 │ Open realtime demo → │         │ token → our own  │       │ GET  /api/users/:id     │
 │ http://…/auth/#token │         │ httpOnly cookie  │       │ POST /api/users/:id/    │
 │                      │         │                  │       │      increment          │
 └──────────────────────┘         └──────────────────┘       └────────────┬────────────┘
          ▲                                                               │ Worker checks the JWT,
          └──── ?handoff=1: near expiry, fetch a fresh link ◀─────────────┤ then getByName(userId)
                                                                          ▼
                                                              User Durable Object
                                                              (one per user), and the
                                                              Directory (one, shared)
```

1. **Pick an account** in the bottom-left account switcher on the dashboard. **Add another account…** takes you to `/dembrane-dashboard/login` to log in with Directus, and adds that account to the switcher. The dashboard also sends you there whenever there's no account, or the current one can't be refreshed, and you come back afterwards.
2. **Click the link.** The token travels in the URL **fragment** (`#token=…`). Browsers never send the fragment to servers, so it stays out of logs and `Referer` headers. `/auth/` hands the token to `POST /api/session`, which verifies it and stores it in the demo's own httpOnly cookie. Then `/auth/` removes the token from the address bar.
3. **Use the demo.** Each request's JWT is checked by `requireDirectusSession`, and the Worker calls the user's Durable Object with `getByName(id)`. The page also asks for the saved list of users with `GET /api/users`, which the Worker answers for admins and, if an admin allows it, for everyone. An admin's **Update** calls `POST /api/users/refresh`: the Worker checks `admin_access` in the token, then passes the admin's own token on to Directus's `/users` (more below). The Durable Objects do no auth themselves, since they can only be reached through the Worker. In Cloudflare's words, *"Durable Objects do not receive requests directly from the Internet. Durable Objects receive requests from Workers or other Durable Objects."* ([docs](https://developers.cloudflare.com/durable-objects/get-started/))
4. **Stay logged in.** The dashboard keeps its token in localStorage, so reloading the page reuses it, and it refreshes the token with its Directus refresh token when it has a minute left. The printed URL changes when this happens. When the demo session has 30 seconds left, or on any 401, `/demo-token/` refreshes it by sending the browser through `/dembrane-dashboard/?handoff=1`, which gets a fresh token and sends it straight back. There's no need to log in again, unless the Directus login can't be refreshed; then you land on the login page, and it continues the handoff once you log in.

Directus access tokens last 15 minutes by default (`ACCESS_TOKEN_TTL`); lower it in Directus to watch the refreshes happen. The demo's threshold (30s) is below the dashboard's (60s) on purpose: the dashboard only hands out tokens with at least a minute left, so a refresh always brings back more time than the demo's threshold and can't loop.

### Why a link, and not dembrane's cookie?

dembrane.com isn't on Cloudflare DNS, so the Worker lives on `*.workers.dev`, outside the dashboard's cookie domain. The browser never sends the dashboard's `dembrane_session_token` cookie there. JavaScript can't read that cookie either (it's httpOnly), so the token has to travel in the link.

Once the Worker can be on a dembrane.com hostname, none of this is needed: see [`dembrane-auth-cookie`](../dembrane-auth-cookie).

## How it maps to dembrane

| Here | In dembrane |
|---|---|
| `src/auth.ts` → `requireDirectusSession` | `require_directus_session` in `echo/server/dembrane/api/dependency_auth.py`: same secret, same algorithm, same claims. Both accept `Authorization: Bearer` or a cookie. (We check the header first, FastAPI the cookie first. With one token per request this makes no difference.) |
| The dashboard's login page | The iOS app (`dembrane-go/.../DembraneCore/Auth.swift`): `POST /auth/login` and `/auth/refresh` with `mode: "json"`, then `Bearer` |
| The `?handoff=1` round trip | The dashboard's Directus SDK refreshing its session (`autoRefresh: true` in `echo/frontend/src/lib/directus.ts`) |
| `admin_access` → the admin badge | `admin_access`, which identifies staff (the admin panel's gate) |

## Try it with curl

With [`directus`](https://github.com/patcon/cloudflare-examples/tree/main/examples/directus) running:

```sh
login() { curl -s localhost:8055/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$2\",\"mode\":\"json\"}" | jq -r .data.access_token; }
A=$(login alice@example.com password); B=$(login bob@example.com password); ADM=$(login admin@dembrane.com admin)
BOB=$(curl -s -H "Authorization: Bearer $B" localhost:9877/api/me | jq -r .id)

curl localhost:9877/api/me                                                   # 401
curl -H "Authorization: Bearer $A" localhost:9877/api/me                      # Alice
curl -H "Authorization: Bearer $A" localhost:9877/api/users                   # 403: admins only
curl -X POST -H "Authorization: Bearer $ADM" localhost:9877/api/users/refresh # save every Directus user
curl -H "Authorization: Bearer $ADM" localhost:9877/api/users                 # the saved list
curl -X PUT -H "Authorization: Bearer $ADM" -H 'content-type: application/json' \
  -d '{"usersCanSeeEachOther":true}' localhost:9877/api/settings
curl -H "Authorization: Bearer $A" localhost:9877/api/users                   # now Alice sees it too
curl -X POST -H "Authorization: Bearer $A" localhost:9877/api/users/$BOB/increment    # 403
curl -X POST -H "Authorization: Bearer $ADM" localhost:9877/api/users/$BOB/increment  # admin: 200
```

## Logging in

Use a Directus you can log into, such as a local dembrane stack or the testing environment. Don't use production.

The quickest option is [`directus`](https://github.com/patcon/cloudflare-examples/tree/main/examples/directus): a local Directus on SQLite with dembrane's schema. It's already set up for this demo (same secret, CORS allows `:9877`), so you can skip steps 1 and 2 below and log in as `alice@example.com` / `password`.

1. Put that Directus's `SECRET` in `.dev.vars` as `DIRECTUS_SECRET`.
2. Allow the demo's origin in Directus's CORS settings: `CORS_ENABLED=true` and `CORS_ORIGIN` including `http://localhost:9877`. This is a config change, not a code change.
3. On the login page, enter the URL, email, password, and a two-factor code if your account uses one. With `../directus`, the Alice, Bob, and Admin buttons fill in its test accounts for you.

The browser talks to Directus directly; the Worker never sees a password.

The token only carries `id`, `role`, `app_access` and `admin_access`. For your name, `POST /api/session` calls Directus's `/users/me` once at login, passing on your own token, so Directus applies your role's permissions and the Worker needs no credentials of its own. It saves the result in your Durable Object, and `/api/me` returns it. This needs the Worker to reach `DIRECTUS_URL` (from `.dev.vars` or `wrangler.jsonc`, not whichever URL you typed on the login page). If it can't, you still log in, and just show as "Directus user".

The list of users works the same way. `POST /api/users/refresh` passes the admin's token on to Directus's `/users`. The Worker checks `admin_access` first and answers anyone else with a 403. It doesn't rely on the page hiding the button, or on Directus, which would answer a non-admin with just themselves. If Directus can't be reached, the admin gets a 502 and the saved list stays as it was. The page does this for you on an admin's first visit, when nothing is saved yet.

The Worker saves the list, and the **Allow everyone to see other users** setting, in one `Directory` Durable Object, which it always asks for by the same name. So both belong to the whole demo, not to any one user, and a non-admin can see other users even though Directus would only tell them about themselves. It's a Durable Object rather than KV because KV is eventually consistent: after an admin changes the setting, some requests could keep seeing the old value for a while, and the setting decides who may read the list. The usual advice against one global Durable Object is about putting every request through it. Here only page loads and admin actions use it; the counters stay in each user's own `User`. Non-admins see a change to the setting when they next load the page.

## Files

```
src/index.ts           routes
src/auth.ts            JWT check, and the raw token to pass on to Directus
src/directus.ts        the Worker's calls to Directus: your profile (fetched at login)
                       and, for admins, everyone's
src/user.ts            the per-user Durable Object: getCount(), increment(), the saved profile
src/directory.ts       the one shared Durable Object: the saved list of users, and settings
public/                the pages (plain HTML, no build step): the dashboard and
                       its login page, /auth/, and /demo-token/
wrangler.jsonc         Durable Object binding, static assets, vars
```

## Going to production

- **How the real dashboard gets a token for the link.** Dashboard JavaScript can't read the httpOnly session cookie. It needs either a small backend endpoint that returns a token for the link (ideally short-lived and valid only for this Worker), or a way to get one from Directus while staying in session mode. The second option still needs checking.
- **Sharing `DIRECTUS_SECRET`.** Anything holding it can create valid dembrane tokens, so the Worker becomes as sensitive as the backend. A token issued only for the Worker, signed with its own secret, avoids this.
- **Logout is only noticed when the token expires.** The JWT is checked locally. FastAPI has exactly the same behaviour today.
- **Tokens in `localStorage`** (the fake dashboard's real login) are acceptable in a demo only.
