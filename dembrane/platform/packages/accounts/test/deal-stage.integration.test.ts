import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// The staff list and the card give the deal stage, read from the account's own documents.
const run = admin ? describe : describe.skip;
const DB = `accounts_deal_stage_${process.pid}`;

run("the deal stage on the staff list and the card", () => {
  setDefaultTimeout(60_000);
  let w: World;
  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("it follows the offer: nothing, drafted, sent", async () => {
    const org = w.otherOrgId;
    const S = `/api/v2/admin/accounts/${org}`;
    const onCard = async () =>
      K.AccountCard.parse((await call(w, "GET", S, "staff")).data).organisation.deal_stage;
    const onList = async () =>
      K.AccountList.parse(
        (await call(w, "GET", "/api/v2/admin/accounts?limit=200", "staff")).data,
      ).accounts.find((a) => a.id === org)?.deal_stage;
    const before = await onCard();
    expect(await onList()).toBe(before);

    const pushed = await call(w, "POST", `${S}/offers`, "staff", {
      template: "subscription",
      language: "en",
      offer_name: "Elders BV",
      person_name: "Anna",
      items: [{ description: "Licence", quantity: 1, unit_price_cents: 1000, vat_rate_bps: 2100 }],
      send: false,
    });
    expect(pushed.status).toBe(201);
    const doc = K.PushOfferResponse.parse(pushed.data).document;
    expect(await onCard()).toBe("offer_drafted");
    expect(await onList()).toBe("offer_drafted");

    expect((await call(w, "POST", `${S}/documents/${doc.id}/send`, "staff", {})).status).toBe(200);
    expect(await onCard()).toBe("offer_sent");
    expect(await onList()).toBe("offer_sent");
  });
});
