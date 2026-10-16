# To do

- [ ] Redirect back to the portal after signing in on the dashboard
  - The dashboard's `?next=` only accepts its own paths for now (`isSafeNextPath` in `frontend/src/components/auth/utils/nextPath.ts`).
  - It would need to allow the portal's origin too, and the portal's "Open the dashboard" link would pass `?next=` with its own URL.
