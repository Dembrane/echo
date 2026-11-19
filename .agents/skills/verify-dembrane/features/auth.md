# Account: register, verify, log in

A new person creates an account with a name, email and password, is refused at login until they verify their email, opens the verification link, and then logs in to the dashboard.

## Sub-features

- `auth-register` creates an unverified account and shows the "Check your email" step.
- `auth-refuse-unverified` refuses login for an unverified account and offers to resend the email.
- `auth-verify` accepts the verification link and returns to login with `?verified=1`.
- `auth-login` signs a verified account in and lands on onboarding (first login) or the home list.

## How to get to it (user POV)

- Open the dashboard at `/register`, or choose "Create account" from `/login`.
- Open the link in the verification email.
- Open the dashboard at `/login`.

## Driving it with agent-browser

Preconditions:

- Baseline run; `EMAIL=verify-$(date +%s)@example.com`, `PASSWORD='Abcdefgh1!xyz'`.

- **Register.** `open "$DASHBOARD_URL/register"`, wait for `[data-testid="auth-register-email-input"]`, fill `auth-register-first-name-input` and `auth-register-email-input`, then `find label "I have read and accept the terms" check` and click `auth-register-continue-button`. Fill `auth-register-password-input` and `auth-register-confirm-password-input`, click `auth-register-submit-button`. `[data-testid="auth-register-verify-step"]` shows "Check your email" and the address. `psql "$DB_URL" -Atc "select email_verified from auth_user where email='$EMAIL'"` prints `f`.
- **Refused before verifying.** `open "$DASHBOARD_URL/login"`, wait for the overlay to clear, fill `auth-login-email-input` and `auth-login-password-input`, click `auth-login-submit-button`. `[data-testid="auth-resend-verification"]` appears.
- **Verify.** `open "$(bun .agents/skills/verify-dembrane/scripts/verify-link.ts "$EMAIL" "$DASHBOARD_URL")"`. The URL becomes `…/en-US/login?verified=1`, and the `email_verified` query prints `t`.
- **Log in.** Wait for the overlay to clear, fill the login fields again, click `auth-login-submit-button`. The URL becomes `…/en-US/onboarding` and the page shows "Welcome, <first name>". `select count(*) from auth_session s join auth_user u on u.id=s.user_id where u.email='$EMAIL'` prints `1`.

## Gotchas

- The terms checkbox can't be clicked directly: the overlay or Mantine's hidden input intercepts it. Use the label.
- Right after login, onboarding shows "Setting things up for you" for a few seconds before "Welcome". Wait for the heading, not the URL alone.
- Registering the same address twice fails. Use a fresh address per run.
- The verification email is never sent locally; the API logs `no SENDGRID_API_KEY: emails are kept in memory`. The minted link is the only way through.
