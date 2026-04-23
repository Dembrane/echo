# QA Accounts

Format: one row per account. All live on localhost:5173.

| Label | Email | Password | Role(s) | Notes |
|-------|-------|----------|---------|-------|
| solo1 | sam.pashikanti+solo1@gmail.com | demo1234 | team owner (Sameer's Team), workspace Default | app_user_id `8842e94f-1b88-4fc2-b785-70a944e0df0b`, directus_user `623ef97f-03f3-4c3b-8923-1dc43f5b338e`, org `3160f520-087c-41c8-9938-90dbd395bd73`, ws `a41f59dd-7384-40b1-895b-51779dc64d60`. **In broken state** — no `workspace_membership` row → empty `/w` home. See pains.md |
| anna | anna@seed.dembrane.dev | demo1234 | seed, unknown state | |
| ben | ben@seed.dembrane.dev | demo1234 | seed, unknown state | |
| cara | cara@seed.dembrane.dev | demo1234 | seed, unknown state | |
| dan | dan@seed.dembrane.dev | demo1234 | seed, unknown state | |
| emma | emma@seed.dembrane.dev | demo1234 | seed, unknown state | |
| finn | finn@seed.dembrane.dev | demo1234 | seed, unknown state | |
| grace | grace@seed.dembrane.dev | demo1234 | seed, unknown state | |
| hank | hank@seed.dembrane.dev | demo1234 | seed, unknown state | |

## Mapped display names (from the seed script Sameer shared)

- anna → Anna Bakker
- ben → Ben Cortez
- cara → Cara Dubois
- dan → Dan Eriksen
- emma → Emma Friedman
- finn → Finn Garcia
- grace → Grace Hughes
- hank → Hank Irving

## Conventions
- Email pattern: `sam.pashikanti+<label>@gmail.com`
- Label = short, descriptive (e.g. `solo1`, `inv-admin`, `billing-only`, `guest-pilot`)
- Record the workspace / team each account belongs to once created
