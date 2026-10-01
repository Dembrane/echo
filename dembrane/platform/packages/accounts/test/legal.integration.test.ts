import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import * as K from "../src/contract";
import {
  legalForPush,
  refreshLegalTexts,
  STALE_AFTER_MS,
  seedLegalTexts,
} from "../src/legal/store";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, type World, world } from "./helpers";

// The daily refresh of dembrane.com/legal and what an offer pins: an unchanged page adds
// nothing, a changed page adds a row, a failed fetch never blocks a push, and a sent offer
// keeps the versions it was sent with.
const run = admin ? describe : describe.skip;
const DB = `accounts_legal_${process.pid}`;

run("legal texts", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const deps = () => ({ db: w.db, fetchText: w.web.fetch, logger: w.deps.logger, now: w.deps.now });
  const count = async (kind: string) =>
    (await w.db.select().from(schema.legal_text).where(eq(schema.legal_text.kind, kind))).length;

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("the reference captures seed each kind once, and a second seed adds nothing", async () => {
    expect(await seedLegalTexts(w.db, w.clock.now)).toBe(3);
    expect(await seedLegalTexts(w.db, w.clock.now)).toBe(0);
    const dpa = await store.latestLegal(w.db, "dpa");
    expect([dpa?.version, dpa?.effectiveOn]).toEqual(["3.0.1", "2026-07-17"]);
  });

  test("an unchanged page adds nothing: the live HTML and the text capture are the same text", async () => {
    const out = await refreshLegalTexts(deps());
    expect(out.map((o) => o.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    for (const k of ["terms", "sla", "dpa"]) expect(await count(k)).toBe(1);
    const sources = await store.legalSources(w.db);
    expect(
      sources.every((s) => s.checkedAt?.getTime() === w.clock.now.getTime() && !s.lastError),
    ).toBe(true);
  });

  test("a changed page adds a new version; layout-only changes do not", async () => {
    const url = "https://www.dembrane.com/legal/sla";
    const page = w.web.pages.get(url) as string;
    w.web.pages.set(url, page.replace("<h2 ", "\n\n<h2 ").replace(/<\/p>/g, "</p>\n"));
    expect((await refreshLegalTexts(deps())).find((o) => o.kind === "sla")?.outcome).toBe(
      "unchanged",
    );
    w.web.pages.set(
      url,
      page
        .replace(
          'aria-label="Version" data-astro-cid-utsu5ych>1.1<',
          'aria-label="Version" data-astro-cid-utsu5ych>1.2<',
        )
        .replace("2026-06-21", "2026-10-01")
        .replace("103 or later", "110 or later"),
    );
    w.clock.now = new Date(w.clock.now.getTime() + 1000);
    const out = await refreshLegalTexts(deps());
    expect(out.find((o) => o.kind === "sla")).toEqual({
      kind: "sla",
      outcome: "inserted",
      version: "1.2",
    });
    expect(await count("sla")).toBe(2);
    const latest = await store.latestLegal(w.db, "sla");
    expect([latest?.version, latest?.effectiveOn]).toEqual(["1.2", "2026-10-01"]);
    expect(latest?.body).toContain("110 or later");
  });

  test("a failed fetch is recorded and logged; nothing changes and nothing throws", async () => {
    w.web.failing = true;
    const out = await refreshLegalTexts(deps());
    expect(out.every((o) => o.outcome === "failed")).toBe(true);
    const sources = await store.legalSources(w.db);
    expect(sources.every((s) => s.lastError === "network unreachable")).toBe(true);
    expect(await count("sla")).toBe(2);
  });

  test("a push refreshes when the last check is over an hour old, and falls back when the fetch fails", async () => {
    // Failing and stale: the push still works on the stored texts.
    w.clock.now = new Date(w.clock.now.getTime() + STALE_AFTER_MS + 1000);
    const calls = w.web.calls;
    const pinned = await legalForPush(deps());
    expect(w.web.calls).toBeGreaterThan(calls);
    expect(pinned.sla.version).toBe("1.2");
    const r = await call(w, "POST", `/api/v2/admin/accounts/${w.orgId}/offers`, "staff", {
      template: "event",
      language: "en",
      offer_name: "Gemeente Testdorp",
      items: [
        {
          description: "dembrane at your event",
          quantity: 1,
          unit_price_cents: 125000,
          vat_rate_bps: 2100,
        },
      ],
    });
    expect(r.status).toBe(201);
    // Fresh: a second push within the hour does not fetch again.
    w.web.failing = false;
    await refreshLegalTexts(deps());
    const before = w.web.calls;
    await legalForPush(deps());
    expect(w.web.calls).toBe(before);
  });

  test("an offer pins the newest texts when pushed, and keeps them after a newer version appears", async () => {
    const push = async () =>
      K.PushOfferResponse.parse(
        (
          await call(w, "POST", `/api/v2/admin/accounts/${w.orgId}/offers`, "staff", {
            template: "subscription",
            language: "en",
            offer_name: "Gemeente Testdorp",
            items: [
              { description: "Licence", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 },
            ],
          })
        ).data,
      ).document;
    const first = await push();
    expect(first.legal.find((l) => l.kind === "sla")?.version).toBe("1.2");
    expect(first.body).toContain("Annex A: Service Level Agreement (version 1.2, 01-10-2026");
    // The DPA changes on the site; the next push after the hour pins it, the first keeps 3.0.1.
    const url = "https://www.dembrane.com/legal/dpa";
    const page = w.web.pages.get(url) as string;
    w.web.pages.set(
      url,
      page
        .replace(/aria-label="Version"([^>]*)>3\.0\.1</, 'aria-label="Version"$1>3.1<')
        .replace("Previous versions are superseded", "All previous versions are superseded"),
    );
    w.clock.now = new Date(w.clock.now.getTime() + STALE_AFTER_MS + 1000);
    const second = await push();
    expect(second.legal.find((l) => l.kind === "dpa")?.version).toBe("3.1");
    const again = K.DocumentDetail.parse(
      (await call(w, "GET", `/api/v2/admin/accounts/${w.orgId}/documents/${first.id}`, "staff"))
        .data,
    );
    expect(again.legal.find((l) => l.kind === "dpa")?.version).toBe("3.0.1");
    expect(again.sha256).toBe(first.sha256);
  });
});
