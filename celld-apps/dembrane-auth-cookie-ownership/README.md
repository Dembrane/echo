# dembrane-auth-cookie-ownership: who owns an organisation, on top of the cookie login

A copy of [`dembrane-auth-cookie`](../dembrane-auth-cookie) that adds a third kind of permission. There, you're either a regular user or a platform admin. Here, you can also **own an organisation**, and that decides what you can do with its projects.

It follows dembrane's own model (the `org`, `org_membership`, `workspace` and `project` collections in echo), cut down to the minimum:

```
org ─┬─ org_membership (user, role: "owner" or "member")
     └─ workspace ── project …
```

| | See the organisation's projects | Increment their counters |
|---|---|---|
| **Owner** of the organisation | yes | yes |
| **Member** of the organisation | yes | no (403) |
| Not in the organisation | no (404) | no (404) |
| **Platform admin** (`admin_access`) | every organisation | yes, anywhere |

dembrane has more roles (`admin`, `billing`, and more on workspaces; see `echo/server/dembrane/policies.py`). This demo only seeds and tells apart the two above. Any other role counts as a member.

The page badges members as **read-only members**, which is true here but not in dembrane. There, an organisation role only covers the organisation (a member's preset is just `org:view`), and what someone can do with projects comes from their role in each *workspace*. A workspace member can create and edit projects; dembrane's read-only role is the workspace `observer`. Nor do organisation members see projects automatically: they ask to join a workspace. This demo skips workspaces (see [Going to production](#going-to-production)).

Everything else is the same as `dembrane-auth-cookie`: the Worker reads Directus's own session cookie, `dembrane_session_token`, and checks its JWT the way dembrane's FastAPI backend does. The per-user counters and the admin-refreshed directory of users are still there, above the new organisations panel.

## Run it

```sh
../../echo/scripts/remote-dev/tunnel.sh   # in another terminal, for the VM's Directus on :8055

pnpm install
cp .dev.vars.example .dev.vars
pnpm dev                         # http://localhost:9879
```

Open <http://localhost:9879> (not 127.0.0.1: Directus allows `localhost` origins, and its cookie is for `localhost`), and log in as a user of the VM's Directus, such as `admin@dembrane.com` / `admin`. It has no organisations yet, so add an `org`, an `org_membership` and a `project` in its admin app (http://localhost:8055/admin) first. The [`directus`](https://github.com/patcon/cloudflare-examples/tree/main/examples/directus) example seeds these, which the rules below are easiest to follow with:

| Organisation | Owner | Members | Projects |
|---|---|---|---|
| Alice's Organisation | Alice | Bob | Town hall listening session, Budget survey |
| Bob's Organisation | Bob | | Park redesign |

So Alice can increment both of her projects and can't see Bob's. Bob can increment Park redesign, and sees Alice's projects but can't increment them. Admin sees and increments everything.

Each example has its own port (`dembrane-auth-token` uses 9877, `dembrane-auth-cookie` 9878), so you can run them side by side.

## Run it on the remote dev VM

With celld on and `./tunnel.sh` open (see [../counter/README.md](../counter/README.md)):

```sh
pnpm run deploy
```

Open http://localhost:8787 and log in as a user of the VM's Directus, such as `admin@dembrane.com` / `admin`. The VM's Directus has no seeded organisations, so add an `org`, an `org_membership` and a `project` in its admin app (http://localhost:8055/admin) first. The VM's celld runs one app at a time, so this replaces whatever was deployed there before. The vars in `wrangler.jsonc` are the VM's values, and `.dev.vars` overrides them for `pnpm dev`.

## How the Worker knows your role

The JWT only carries `id`, `role`, `app_access` and `admin_access`. It says nothing about organisations, so the Worker asks Directus.

**It can't ask as you.** dembrane's Basic User role has no read permission on `org`, `org_membership` or `project`. dembrane's backend doesn't read them as the user either. It uses a server-side admin token (the `async_directus` client in `echo/server/dembrane/directus_async.py`) and applies the rules in Python. The Worker does the same, with its own service token, `DIRECTUS_TOKEN`. Locally that's `../directus`'s `ADMIN_TOKEN`.

This is the one real change from `dembrane-auth-cookie`: there, the Worker needs no Directus credentials of its own. Here it does.

**It asks on every request.** `/api/orgs` and both project routes look up your memberships with one query. It filters `org_membership` through its `user_id` (an `app_user`) to that user's `directus_user_id`, which is the `id` in your token:

```
GET /items/org_membership?filter[user_id][directus_user_id][_eq]=<id>&filter[deleted_at][_null]=true
    &fields=role,org_id.id,org_id.name
```

Nothing is cached, so a change of owner in Directus applies on the next request. Each project's counter lives in its own `Project` Durable Object (`getByName(projectId)`), which, like `User`, does no auth itself.

The rules are in `src/ownership.ts`, two one-line functions: `canSeeProjects` and `canIncrementProjects`.

## Try it with curl

With [`directus`](https://github.com/patcon/cloudflare-examples/tree/main/examples/directus) running. See [`dembrane-auth-cookie`](../dembrane-auth-cookie#try-it-with-curl) for logging in by cookie; Bearer is shorter here:

```sh
login() { curl -s localhost:8055/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$2\",\"mode\":\"json\"}" | jq -r .data.access_token; }
A=$(login alice@example.com password); B=$(login bob@example.com password); ADM=$(login admin@dembrane.com admin)
TOWN=0a11ce00-0000-4000-8000-0000000000a1   # Alice's; the seed uses fixed ids
PARK=0b0b0000-0000-4000-8000-0000000000b1   # Bob's

curl -H "Authorization: Bearer $B" localhost:9879/api/orgs                             # Alice's (member), Bob's (owner)
curl -X POST -H "Authorization: Bearer $A" localhost:9879/api/projects/$TOWN/increment   # 200: Alice owns it
curl -X POST -H "Authorization: Bearer $B" localhost:9879/api/projects/$TOWN/increment   # 403: Bob is only a member
curl -H "Authorization: Bearer $B" localhost:9879/api/projects/$TOWN                     # 200: but can see it
curl -X POST -H "Authorization: Bearer $A" localhost:9879/api/projects/$PARK/increment   # 404: Alice isn't in Bob's
curl -X POST -H "Authorization: Bearer $ADM" localhost:9879/api/projects/$PARK/increment # 200: platform admin
```

A project you can't see answers 404, not 403, so it doesn't reveal which projects exist.

## Files

```
src/index.ts           routes: /api/me, /api/users…, /api/settings, and now /api/orgs, /api/projects…
src/auth.ts            JWT check on Directus's cookie (or Bearer), and the origin check
src/ownership.ts       who may see and increment an organisation's projects
src/directus.ts        the Worker's calls to Directus: as you (your profile, and for admins
                       everyone's), and with its service token (organisations and projects)
src/project.ts         the per-project Durable Object: getCount(), increment()
src/user.ts            the per-user Durable Object: getCount(), increment(), the saved profile
src/directory.ts       the one shared Durable Object: the saved list of users, and settings
public/                the pages (plain HTML, no build step): /login/ and /demo-ownership/
wrangler.jsonc         Durable Object bindings, static assets, vars
```

## Going to production

Everything in [`dembrane-auth-cookie`'s list](../dembrane-auth-cookie#going-to-production), plus:

- **The service token.** `DIRECTUS_TOKEN` can read every organisation and project. Give the Worker a Directus user and policy of its own that can only read `org_membership`, `org` and `project` (just the fields above), not an admin token. Or have the Worker call a small dembrane backend endpoint that answers "what's this user's role in the org of project X?", so the rules live in one place (`policies.py`).
- **Two Directus calls per project request.** Fine for a demo. For real traffic, cache memberships briefly (in the user's Durable Object, say), and accept that a change of owner then takes that long to apply.
- **Workspaces are skipped.** In dembrane, access to a project also goes through the workspace: `workspace_membership`, the workspace's `visibility`, and private projects (`inheritance.py`). Organisation owners get in on any workspace visibility, which is the case shown here.
