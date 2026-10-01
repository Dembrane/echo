import { expect, test } from "bun:test";
import { loadConfig, schema } from "../src";
import { walk } from "../src/define";
import { load } from "../src/load";

/**
 * Every feature and kill switch, with the value it must take when nobody sets it and the
 * value prod and echo-next run with. The defaults mirror what the Python stack does on
 * prod today, so a key a deployment forgets keeps prod's behaviour instead of switching a
 * feature off at cutover. Changing a row here is a behaviour change for customers.
 */
const switches = [
  { path: "webhooks.enabled", env: "ENABLE_WEBHOOKS", default: true, prod: true, staging: true },
  {
    path: "webhooks.allowPrivateTargets",
    env: "WEBHOOKS_ALLOW_PRIVATE_TARGETS",
    default: false,
    prod: false,
    staging: false,
  },
  {
    path: "conversations.participantTokenRequired",
    env: "PARTICIPANT_TOKEN_REQUIRED",
    default: false,
    prod: false,
    staging: false,
  },
  {
    path: "conversations.monitorEnabled",
    env: "ENABLE_MONITOR",
    default: true,
    prod: true,
    staging: true,
  },
  {
    path: "analysis.enablePresent",
    env: "ENABLE_PRESENT",
    default: true,
    prod: true,
    staging: true,
  },
  { path: "canvas.enabled", env: "ENABLE_CANVAS", default: true, prod: true, staging: true },
  {
    path: "billing.forceReconcileFailure",
    env: "MOLLIE_FORCE_RECONCILE_FAILURE",
    default: false,
    prod: false,
    staging: false,
  },
  {
    path: "billing.customerJobs",
    env: "BILLING_CUSTOMER_JOBS",
    default: "off",
    prod: "on",
    staging: "off",
  },
  {
    path: "popcorn.showFlow",
    env: "POPCORN_SHOW_FLOW",
    default: false,
    prod: false,
    staging: true,
  },
] as const;

const secrets = Object.fromEntries(
  [...walk(schema)]
    .filter(([, k]) => k.meta.secret)
    .map(([, k]) => [
      k.meta.env,
      k.meta.env.endsWith("_URL") ? "postgres://u@h/d" : "s".repeat(48),
    ]),
);
const required = {
  ...secrets,
  APP_ENV: "prod",
  API_PUBLIC_URL: "https://api.example",
  DASHBOARD_URL: "https://dashboard.example",
  PORTAL_URL: "https://portal.example",
};

function valueAt(values: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((o, part) => (o as Record<string, unknown>)?.[part], values);
}

test("every switch in the table is declared under its variable", () => {
  const declared = new Map([...walk(schema)].map(([path, k]) => [path, k.meta.env]));
  for (const s of switches) expect(declared.get(s.path)).toBe(s.env);
});

for (const s of switches) {
  test(`${s.env} defaults to ${s.default} when nothing sets it`, () => {
    // No environment file: only the schema default applies.
    const { values } = load(schema, undefined, required);
    expect(valueAt(values, s.path)).toBe(s.default);
  });

  test(`${s.env} resolves to ${s.prod} on prod and ${s.staging} on staging`, () => {
    expect(valueAt(loadConfig({ ...secrets, APP_ENV: "prod" }).values, s.path)).toBe(s.prod);
    expect(valueAt(loadConfig({ ...secrets, APP_ENV: "staging" }).values, s.path)).toBe(s.staging);
  });
}
