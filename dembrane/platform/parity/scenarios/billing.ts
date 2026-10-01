import { billing, orgs } from "../fixtures";
import { scenarios } from "../runner/scenario";

// The parity stack has no Mollie key, so both sides answer every Mollie-bound path the
// way an unconfigured environment does. The Mollie flows themselves (checkout, webhook
// routing, reconcile, cancel and resume) are proven against the fake in
// packages/billing/test.
const A = `/api/v2/billing-accounts/${billing.a}`;
const B = `/api/v2/billing-accounts/${billing.b}`;
const MISSING = "/api/v2/billing-accounts/ba000000-0000-4000-8000-000000000099";

export default scenarios([
  // Org billing page: org owner, admin, billing role or staff.
  {
    name: "billing org: alice (owner) reads org A",
    as: "alice",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/billing`,
  },
  {
    name: "billing org: erin (admin) reads org A",
    as: "erin",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/billing`,
  },
  {
    name: "billing org: staff reads org B",
    as: "admin",
    method: "GET",
    path: `/api/v2/orgs/${orgs.b}/billing`,
  },
  {
    name: "billing org: bob (other tenant) is refused",
    as: "bob",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/billing`,
  },
  {
    name: "billing org: rita (no org role) is refused",
    as: "rita",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/billing`,
  },
  {
    name: "billing org: dave (not onboarded) is refused",
    as: "dave",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/billing`,
  },
  {
    name: "billing org: anonymous is refused",
    as: "anonymous",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/billing`,
  },

  // Overview.
  {
    name: "billing overview: alice reads account A",
    as: "alice",
    method: "GET",
    path: `${A}/overview`,
  },
  {
    name: "billing overview: erin reads account A",
    as: "erin",
    method: "GET",
    path: `${A}/overview`,
  },
  {
    name: "billing overview: bob reads his own account B",
    as: "bob",
    method: "GET",
    path: `${B}/overview`,
  },
  {
    name: "billing overview: staff reads account B",
    as: "admin",
    method: "GET",
    path: `${B}/overview`,
  },
  {
    name: "billing overview: bob is refused on account A",
    as: "bob",
    method: "GET",
    path: `${A}/overview`,
  },
  { name: "billing overview: rita is refused", as: "rita", method: "GET", path: `${A}/overview` },
  {
    name: "billing overview: dave (not onboarded) is refused",
    as: "dave",
    method: "GET",
    path: `${A}/overview`,
  },
  {
    name: "billing overview: unknown account is not found",
    as: "alice",
    method: "GET",
    path: `${MISSING}/overview`,
  },
  {
    name: "billing overview: anonymous is refused",
    as: "anonymous",
    method: "GET",
    path: `${A}/overview`,
  },

  // Checkout: Mollie is off in parity, so a valid request is a 400 after the access checks.
  {
    name: "billing checkout: alice without Mollie gets a 400",
    as: "alice",
    method: "POST",
    path: `${A}/checkout`,
    body: { tier: "changemaker", billing_period: "monthly", redirect_url: "https://app.test/back" },
  },
  {
    name: "billing checkout: staff without Mollie gets a 400",
    as: "admin",
    method: "POST",
    path: `${B}/checkout`,
    body: { tier: "changemaker", redirect_url: "https://app.test/back" },
  },
  {
    name: "billing checkout: invalid tier, cadence and missing url are all reported",
    as: "alice",
    method: "POST",
    path: `${A}/checkout`,
    body: { tier: "gold", billing_period: "weekly" },
  },
  {
    name: "billing checkout: a missing body is a 422",
    as: "alice",
    method: "POST",
    path: `${A}/checkout`,
  },
  {
    name: "billing checkout: an empty redirect url is too short",
    as: "alice",
    method: "POST",
    path: `${A}/checkout`,
    body: { tier: "changemaker", redirect_url: "" },
  },
  {
    name: "billing checkout: validation comes before not found",
    as: "alice",
    method: "POST",
    path: `${MISSING}/checkout`,
    body: { tier: "x" },
  },
  {
    name: "billing checkout: rita is refused",
    as: "rita",
    method: "POST",
    path: `${A}/checkout`,
    body: { tier: "changemaker", redirect_url: "https://app.test/back" },
  },
  {
    name: "billing checkout: anonymous is refused before validation",
    as: "anonymous",
    method: "POST",
    path: `${A}/checkout`,
    body: { tier: "x" },
  },

  // Sync.
  {
    name: "billing sync: alice syncs an account without a Mollie customer",
    as: "alice",
    method: "POST",
    path: `${A}/sync`,
  },
  {
    name: "billing sync: the method flow adds the method outcome",
    as: "alice",
    method: "POST",
    path: `${A}/sync`,
    query: { flow: "method" },
  },
  {
    name: "billing sync: bob is refused on account A",
    as: "bob",
    method: "POST",
    path: `${A}/sync`,
  },

  // Invoices and estimate.
  {
    name: "billing invoices: alice lists an account without payments",
    as: "alice",
    method: "GET",
    path: `${A}/invoices`,
  },
  {
    name: "billing invoices: limit 0 is below the minimum",
    as: "alice",
    method: "GET",
    path: `${A}/invoices`,
    query: { limit: "0" },
  },
  {
    name: "billing invoices: limit 101 is above the maximum",
    as: "alice",
    method: "GET",
    path: `${A}/invoices`,
    query: { limit: "101" },
  },
  {
    name: "billing invoices: a non-numeric limit is a 422",
    as: "alice",
    method: "GET",
    path: `${A}/invoices`,
    query: { limit: "ten" },
  },
  { name: "billing invoices: rita is refused", as: "rita", method: "GET", path: `${A}/invoices` },
  {
    name: "billing estimate: alice previews every tier at 4 seats",
    as: "alice",
    method: "GET",
    path: `${A}/estimate`,
  },
  {
    name: "billing estimate: bob previews his free account",
    as: "bob",
    method: "GET",
    path: `${B}/estimate`,
  },
  {
    name: "billing estimate: bob is refused on account A",
    as: "bob",
    method: "GET",
    path: `${A}/estimate`,
  },

  // Billing details.
  {
    name: "billing details: alice reads the empty capture",
    as: "alice",
    method: "GET",
    path: `${A}/billing-details`,
  },
  {
    name: "billing details: alice saves only the fields she sent",
    as: "alice",
    method: "PUT",
    path: `${A}/billing-details`,
    body: {
      billing_legal_name: "Parity Org A B.V.",
      billing_vat_id: "NL123",
      billing_vat_region: "eu",
      billing_city: null,
    },
  },
  {
    name: "billing details: erin saves an empty body",
    as: "erin",
    method: "PUT",
    path: `${A}/billing-details`,
    body: {},
  },
  {
    name: "billing details: staff saves on account B",
    as: "admin",
    method: "PUT",
    path: `${B}/billing-details`,
    body: { billing_country: "NL" },
  },
  {
    name: "billing details: an unknown VAT region is a 422",
    as: "alice",
    method: "PUT",
    path: `${A}/billing-details`,
    body: { billing_vat_region: "mars" },
  },
  {
    name: "billing details: a number for a text field is a 422",
    as: "alice",
    method: "PUT",
    path: `${A}/billing-details`,
    body: { billing_city: 12 },
  },
  {
    name: "billing details: bob is refused on account A",
    as: "bob",
    method: "PUT",
    path: `${A}/billing-details`,
    body: { billing_city: "Utrecht" },
  },

  // Invoice PDF: Mollie is required, so without it the old API crashes with a plain-text 500.
  {
    name: "billing invoice pdf: without Mollie the lookup fails",
    as: "alice",
    method: "GET",
    path: `${A}/invoices/inv_x/pdf`,
    differs:
      "unhandled Mollie failure: the error handler answers {detail} JSON where Starlette sent a plain-text 500",
  },
  {
    name: "billing invoice pdf: bob is refused on account A",
    as: "bob",
    method: "GET",
    path: `${A}/invoices/inv_x/pdf`,
  },

  // Cancel, resume, payment method, retry.
  {
    name: "billing cancel: nothing to cancel returns the status",
    as: "alice",
    method: "POST",
    path: `${A}/cancel`,
    body: { reason: "too_expensive" },
  },
  {
    name: "billing cancel: a missing body is a 422",
    as: "alice",
    method: "POST",
    path: `${A}/cancel`,
  },
  {
    name: "billing cancel: rita is refused",
    as: "rita",
    method: "POST",
    path: `${A}/cancel`,
    body: {},
  },
  {
    name: "billing resume: without Mollie gets a 400",
    as: "alice",
    method: "POST",
    path: `${A}/resume`,
  },
  {
    name: "billing resume: bob is refused on account A",
    as: "bob",
    method: "POST",
    path: `${A}/resume`,
  },
  {
    name: "billing payment method: without Mollie gets a 400",
    as: "alice",
    method: "POST",
    path: `${A}/payment-method/checkout`,
    body: { redirect_url: "https://app.test/back" },
  },
  {
    name: "billing payment method: a missing redirect url is a 422",
    as: "alice",
    method: "POST",
    path: `${A}/payment-method/checkout`,
    body: {},
  },
  {
    name: "billing retry: an account that is not past due keeps its status",
    as: "alice",
    method: "POST",
    path: `${A}/retry-charge`,
  },
  {
    name: "billing retry: staff retries account B",
    as: "admin",
    method: "POST",
    path: `${B}/retry-charge`,
  },
  {
    name: "billing retry: anonymous is refused",
    as: "anonymous",
    method: "POST",
    path: `${A}/retry-charge`,
  },

  // Mollie webhook: public; the id must come as a form field.
  {
    name: "billing webhook: a JSON body carries no form id",
    as: "anonymous",
    method: "POST",
    path: "/api/v2/billing/mollie/webhook",
    body: { id: "tr_x" },
  },
  {
    name: "billing webhook: no body is a 422",
    as: "anonymous",
    method: "POST",
    path: "/api/v2/billing/mollie/webhook",
  },
]);
