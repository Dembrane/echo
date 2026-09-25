# dembrane-auth-cookie: a Worker inside dembrane's cookie domain, logged in by cookie

A minimal example of gating a Cloudflare Worker and Durable Object on a **dembrane login**, when the Worker is **inside dembrane's cookie domain** (`.dembrane.com`), for example on `demo-cookie.dembrane.com`. Directus sets its session cookie for that whole domain, so the browser sends dembrane's own session cookie to the Worker, so there's no link, no token handoff and no cookie of the Worker's own.

It's the simpler version of [`dembrane-auth-token`](../dembrane-auth-token), which works when the Worker is outside that cookie domain. The two differ in how the Worker gets your login:

| | [`dembrane-auth-token`](../dembrane-auth-token) | [`dembrane-auth-cookie`](../dembrane-auth-cookie) (this one) |
|---|---|---|
| **Use it when** | The Worker is **outside dembrane's cookie domain**, such as on `*.workers.dev`. That's the case today, since dembrane.com isn't on Cloudflare DNS | The Worker can be **inside dembrane's cookie domain**, `.dembrane.com`: on a hostname like `demo-cookie.dembrane.com` |
| **How the Worker learns who you are** | The dashboard puts your token in a link. The Worker keeps it in a cookie of its own | The browser sends dembrane's own session cookie. The Worker only reads it |
| **Staying logged in** | The demo goes back to the dashboard for a fresh link | The demo asks Directus to refresh the session |
| **Logging out** | Of the demo only | Of dembrane, everywhere: it's one session |
| **Accounts** | Several, with an account switcher | One per browser |
| **Open questions for production** | How the real dashboard gets a token to put in the link | Moving the dembrane.com zone to Cloudflare, and allowing the demo's origin in Directus's CORS |

The Worker still verifies the same Directus JWT as dembrane's FastAPI backend, the same way: HS256 with `DIRECTUS_SECRET`, reading `id` and `admin_access`. It routes each user to their own Durable Object. **dembrane's code doesn't change.**

What you'll see is the same demo as `dembrane-auth-token`: a counter per user in their own Durable Object, and a shared directory of users that admins refresh from Directus. The rules are the same, and the Worker enforces them.

It's built for [`directus`](https://github.com/patcon/cloudflare-examples/tree/main/examples/directus), which already names its cookie `dembrane_session_token` like production, and allows this Worker's origin in CORS.

## Run it

```sh
../../echo/scripts/remote-dev/tunnel.sh   # in another terminal, for the VM's Directus on :8055

pnpm install
cp .dev.vars.example .dev.vars
pnpm dev                         # http://localhost:9878
```

Open <http://localhost:9878> (not 127.0.0.1: Directus allows `localhost` origins, and its cookie is for `localhost`). It redirects to `/demo-cookie/`, which sends you to `/login/` until you're logged in. Each example has its own port (`dembrane-auth-token` uses 9877, `dembrane-auth-cookie-ownership` 9879), so you can run them side by side.

## Run it on the remote dev VM

With celld on and `./tunnel.sh` open (see [../counter/README.md](../counter/README.md)):

```sh
pnpm run deploy
```

Open http://localhost:8787 and log in as a user of the VM's Directus, such as `admin@dembrane.com` / `admin`. The VM's celld runs one app at a time, so this replaces whatever was deployed there before. The vars in `wrangler.jsonc` are the VM's values, and `.dev.vars` overrides them for `pnpm dev`.

## Why it works locally

Cookies ignore the port. The cookie that Directus on `localhost:8055` sets is sent to the Worker on `localhost:9878` too, just as a cookie for `.dembrane.com` would reach `demo-cookie.dembrane.com`. You can also log in to Directus's own app at <http://localhost:8055/admin> as the admin. It uses the same cookie, so the demo sees you as logged in.

## The flow

```
 /login/ (pretend: dashboard.dembrane.com/login)     /demo-cookie/ (pretend: demo-cookie.dembrane.com)
 ┌────────────────────────────────────┐            ┌─────────────────────────┐
 │ POST {directus}/auth/login         │            │ GET  /api/me            │
 │   mode: "session"                  │ ─────────▶ │ GET  /api/users         │
 │ Directus sets dembrane_session_    │            │ POST /api/users/:id/    │
 │ token (httpOnly) for the domain    │            │      increment          │
 └────────────────────────────────────┘            └────────────┬────────────┘
          ▲                                                     │ the browser sends the cookie;
          └──── no session left to refresh ◀────────────────────┤ the Worker checks the JWT,
                                                                │ then getByName(userId)
            POST {directus}/auth/refresh ◀── near expiry, or    ▼
            mode: "session"                  on a 401     User Durable Object (one per
                                                          user), and the Directory (one)
```

1. **Log in.** `/login/` stands in for dembrane's login. It calls Directus's `POST /auth/login` with `mode: "session"` and `credentials: "include"`, the way the dashboard's Directus SDK does. Directus answers by setting its httpOnly session cookie. The page never sees the token.
2. **Use the demo.** Every request to the Worker carries the cookie. `requireDirectusSession` checks the JWT in it, and the Worker calls the user's Durable Object with `getByName(id)`. The Durable Objects do no auth themselves, since they can only be reached through the Worker.
3. **Stay logged in.** With a minute left, or on any 401, `/demo-cookie/` calls Directus's `POST /auth/refresh` with `mode: "session"`. Directus replaces the cookie with a fresh one, and the page asks `/api/me` again. If there's no session left to refresh, you go back to `/login/`, which returns you afterwards. Session tokens last a day by default (`SESSION_COOKIE_TTL`). Lower it in `../directus/.env` to watch the refreshes happen, but keep it above a minute or the page will refresh in a loop.
4. **Log out.** Directus's `POST /auth/logout` ends the session and deletes the cookie. There's only one session, so this logs you out of dembrane too.

## What's different from dembrane-auth

| dembrane-auth | Here |
|---|---|
| `/auth/` swaps a `#token` link for the Worker's own `demo_session_cookie` | Gone. The Worker reads Directus's `dembrane_session_token` |
| `POST /api/session` and `DELETE /api/session` | Gone. Directus's `/auth/login` and `/auth/logout` set and delete the cookie |
| The dashboard stand-in, with an account switcher and tokens in localStorage | A login page. A browser holds one Directus session, so there's one account at a time |
| `?handoff=1`: the demo goes back to the dashboard for a fresh token | The demo refreshes the session with Directus itself |
| Your profile is fetched in `POST /api/session` | Fetched by `GET /api/me` the first time the Worker sees you. There's no login step here to do it in |
| The Worker's cookie is only ever sent to the Worker's own host | Directus's cookie is sent to every host in its domain, so writes need the origin check below |

### The origin check

The browser attaches the cookie to any request made from a page inside its domain. That includes pages on other `*.dembrane.com` hosts, or on other `localhost` ports. `SameSite=Lax` only stops pages outside the domain, not those. So `requireDirectusSession` turns down a request that changes something (`POST`, `PUT`, …) and is authenticated only by the cookie, unless it comes from the Worker's own origin. It checks this with `Sec-Fetch-Site: same-origin`, or with `Origin` for browsers that don't send that header. Bearer requests skip the check, because another page can't make the browser attach an `Authorization` header.

## Try it with curl

With [`directus`](https://github.com/patcon/cloudflare-examples/tree/main/examples/directus) running. curl keeps cookies by host, not port, just as the browser does, so the cookie from `:8055` is sent to `:9878`:

```sh
login() { curl -s -c "$1" localhost:8055/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$2\",\"password\":\"$3\",\"mode\":\"session\"}" -o /dev/null; }
login alice.txt alice@example.com password
ME=$(curl -s -b alice.txt localhost:9878/api/me | jq -r .id)

curl localhost:9878/api/me                                                     # 401
curl -b alice.txt localhost:9878/api/me                                        # Alice
curl -b alice.txt -X POST localhost:9878/api/users/$ME/increment               # 403: not from the demo's origin
curl -b alice.txt -H 'Origin: http://localhost:9878' -X POST localhost:9878/api/users/$ME/increment   # 200
curl -b alice.txt -H 'Origin: http://localhost:5173' -X POST localhost:9878/api/users/$ME/increment   # 403
```

`Authorization: Bearer` still works too, with the token from the cookie or from a `mode: "json"` login. The curl examples in [`dembrane-auth-token`](../dembrane-auth-token#try-it-with-curl) work unchanged.

## Files

```
src/index.ts           routes
src/auth.ts            JWT check on Directus's cookie (or Bearer), and the origin check
src/directus.ts        the Worker's calls to Directus: your profile, and, for admins, everyone's
src/user.ts            the per-user Durable Object: getCount(), increment(), the saved profile
src/directory.ts       the one shared Durable Object: the saved list of users, and settings
public/                the pages (plain HTML, no build step): /login/ and /demo-cookie/
wrangler.jsonc         Durable Object bindings, static assets, vars
```

## Going to production

- **The Worker must be on dembrane.com.** That means a custom domain or route, so the dembrane.com zone has to be on Cloudflare. This is why `dembrane-auth-token` uses a link instead. Directus must also set its cookie for the whole domain (`SESSION_COOKIE_DOMAIN=.dembrane.com`), which production already does.
- **CORS.** `/demo-cookie/` calls Directus's `/auth/refresh` and `/auth/logout` itself, so Directus's `CORS_ORIGIN` must include the demo's origin, with `CORS_CREDENTIALS=true`.
- **Sharing `DIRECTUS_SECRET`.** Anything holding it can create valid dembrane tokens, so the Worker becomes as sensitive as the backend.
- **Logout is only noticed when the token expires.** The browser forgets the cookie at once, but the Worker checks the JWT locally, so a copied token stays valid until `exp`. Session tokens last a day by default rather than 15 minutes. FastAPI behaves the same way today.
- **Every host in the domain can set the cookie.** Any `*.dembrane.com` page can write a cookie for `.dembrane.com`, so a compromised subdomain could log visitors in to another account. It can't forge one, since the Worker still checks the signature.
