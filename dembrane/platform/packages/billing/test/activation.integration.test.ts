import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, createDb, migrate } from "@dembrane/db";
import { MemoryMailer } from "@dembrane/mail";
import { createBilling, FakeMollie } from "../src";
import { logger } from "./helpers";

// Activation from a paid consent against Postgres. Needs a scratch Postgres
// (TEST_DATABASE_ADMIN_URL).
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `billing_activation_${process.pid}`;

run("activation from the first payment", () => {
  setDefaultTimeout(60_000);
  let url: string;

  const dropDb = async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    return a;
  };

  beforeAll(async () => {
    const a = await dropDb();
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
  });

  afterAll(async () => {
    await (await dropDb()).end();
  });

  test("a paid consent activates on one connection, so a full pool cannot stall it", async () => {
    const single = createDb({ url, poolMax: 1 });
    try {
      const mollie = new FakeMollie();
      const billing = createBilling({
        db: single.db,
        mollie,
        mailer: new MemoryMailer(),
        logger,
        billingConfig: {
          webhookUrl: "https://api.test/api/v2/billing/mollie/webhook",
          forceReconcileFailure: false,
          dashboardUrl: "https://dash.test/",
        },
      });
      const org = randomUUID();
      const acc = randomUUID();
      await single.client`insert into org (id, name) values (${org}, 'Acme')`;
      await single.client`insert into billing_account (id, tier, status, org_id)
        values (${acc}, 'free', 'pending', ${org})`;
      const customer = await mollie.createCustomer({ name: "Acme", email: "pay@acme.test" });
      const payment = await mollie.createFirstPayment({
        customerId: String(customer.id),
        amountEur: 3600,
        description: "Changemaker",
        redirectUrl: "https://dash.test/back",
        metadata: {
          billing_account_id: acc,
          intent: "activate",
          tier: "changemaker",
          billing_period: "annual",
          interval: "12 months",
          seats: 2,
          amount_eur: 3600,
        },
      });
      mollie.settle(String(payment.id), "paid");

      const outcome = await Promise.race([
        billing.service.handleWebhook(String(payment.id)).then(() => "activated"),
        Bun.sleep(5_000).then(() => "stalled"),
      ]);
      expect(outcome).toBe("activated");
      const [sub] = mollie.callsOf("createSubscription") as Record<string, unknown>[];
      expect(sub).toMatchObject({ amountEur: 3600, metadata: { billing_account_id: acc } });
      expect(await billing.store.account(acc)).toMatchObject({
        tier: "changemaker",
        status: "active",
        payment_mode: "mollie",
        mollie_subscription_id: expect.stringMatching(/^sub_/),
        provisioned_seats: 2,
      });
    } finally {
      await single.close();
    }
  });
});
