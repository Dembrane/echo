import { Writable } from "node:stream";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger, type Logger } from "@dembrane/observability";
import {
  accountRow,
  BillingService,
  FakeMollie,
  MemoryBillingStore,
  Notifier,
  RepriceMemo,
} from "../src";
import type { AccountRow } from "../src/store";

export const NOW = new Date("2026-09-27T10:00:00.000Z");
export const ORG = "b0000000-0000-4000-8000-000000000001";
export const WS1 = "c0000000-0000-4000-8000-000000000001";
export const WS2 = "c0000000-0000-4000-8000-000000000002";
export const ACC = "ba000000-0000-4000-8000-000000000001";
export const U = {
  owner: "a0000000-0000-4000-8000-000000000001",
  admin: "a0000000-0000-4000-8000-000000000002",
  member: "a0000000-0000-4000-8000-000000000003",
  external: "a0000000-0000-4000-8000-000000000004",
  observer: "a0000000-0000-4000-8000-000000000005",
};

export const logLines: Record<string, unknown>[] = [];
export const logger: Logger = createLogger(
  { service: "t", release: "r", env: "test", level: "debug" },
  new Writable({
    write(c, _e, cb) {
      logLines.push(JSON.parse(c.toString()));
      cb();
    },
  }),
);

/**
 * An org with an org-scoped account covering two workspaces. Live seats: owner, admin,
 * member (WS1) and external (WS2) = 4; the observer and the member's second row are free
 * or duplicates.
 */
export function world(account: Partial<AccountRow> = {}) {
  const store = new MemoryBillingStore();
  store.orgs.set(ORG, "Acme");
  store.accounts.set(
    ACC,
    accountRow({
      id: ACC,
      org_id: ORG,
      tier: "changemaker",
      created_by: U.owner,
      label: "Acme",
      ...account,
    }),
  );
  for (const [id, name] of [
    [WS1, "Main"],
    [WS2, "Clients"],
  ] as const)
    store.workspaces.set(id, {
      id,
      name,
      org_id: ORG,
      visibility: "open_to_organisation",
      settings: {},
      deleted_at: null,
      billing_account_id: ACC,
    });
  let n = 0;
  const mem = (workspace_id: string, user_id: string, role: string, source = "direct") =>
    store.memberships.push({
      id: `e1000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      workspace_id,
      user_id,
      role,
      source,
    });
  mem(WS1, U.owner, "owner");
  mem(WS1, U.admin, "admin");
  mem(WS1, U.member, "member");
  mem(WS2, U.member, "member");
  mem(WS2, U.external, "external");
  mem(WS2, U.observer, "observer");
  store.orgMembers.push(
    { id: "e0000000-0000-4000-8000-000000000001", org_id: ORG, user_id: U.owner, role: "owner" },
    { id: "e0000000-0000-4000-8000-000000000002", org_id: ORG, user_id: U.admin, role: "admin" },
  );
  for (const [k, id] of Object.entries(U))
    store.users.set(id, { id, email: `${k}@acme.test`, display_name: k });

  const mollie = new FakeMollie();
  const mailer = new MemoryMailer();
  const notifier = new Notifier(store, logger);
  const clock = { now: NOW };
  const held = new Set<string>();
  const service = new BillingService({
    store,
    mollie,
    mailer,
    notifier,
    logger,
    config: {
      webhookUrl: "https://api.test/api/v2/billing/mollie/webhook",
      forceReconcileFailure: false,
      dashboardUrl: "https://dash.test/",
    },
    capture: async () => {},
    repriceMemo: new RepriceMemo(),
    tryLock: async (key, fn) => {
      if (held.has(key)) return undefined;
      held.add(key);
      try {
        return await fn();
      } finally {
        held.delete(key);
      }
    },
    clock: () => clock.now,
  });
  const acc = () => store.accounts.get(ACC) as AccountRow;
  return { store, mollie, mailer, notifier, service, clock, acc, held };
}
