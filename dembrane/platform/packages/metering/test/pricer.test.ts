import { describe, expect, test } from "bun:test";
import type { ModelCall } from "@dembrane/llm";
import type { PriceRow, PriceSnapshot, UnitPrices } from "../src/prices/book";
import { priceCall } from "../src/prices/pricer";

const call = (over: Partial<ModelCall> = {}): ModelCall => ({
  group: "multi_modal_pro",
  provider: "vertex",
  model: "gemini-3.8-flash",
  kind: "generate",
  startedAt: new Date("2026-11-03T12:00:00Z"),
  ms: 1000,
  inputTokens: null,
  cachedInputTokens: null,
  audioInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  audioSeconds: null,
  searchQueries: null,
  usageEstimated: false,
  finishReason: "stop",
  status: "ok",
  error: null,
  attempt: 1,
  fallback: false,
  ...over,
});

const none: UnitPrices = {
  currency: "USD",
  inputPerM: null,
  cachedInputPerM: null,
  audioInputPerM: null,
  outputPerM: null,
  longContext: null,
  perAudioSecond: null,
  perSearchQuery: null,
};

let nextId = 1;
const row = (key: string, prices: Partial<UnitPrices>): PriceRow => {
  const [provider, model] = key.split("/") as [string, string];
  return {
    ...none,
    ...prices,
    id: nextId++,
    provider,
    model,
    source: "models.dev",
    effectiveFrom: new Date("2026-11-01T00:00:00Z"),
  };
};

const gemini = row("vertex/gemini-3.8-flash", {
  inputPerM: 0.75,
  cachedInputPerM: 0.075,
  audioInputPerM: 0.75,
  outputPerM: 3.75,
  perSearchQuery: 0.014,
});
const pro = row("vertex/gemini-3.1-pro-preview", {
  inputPerM: 2,
  cachedInputPerM: 0.2,
  outputPerM: 12,
  longContext: { threshold: 200000, inputPerM: 4, cachedInputPerM: 0.4, outputPerM: 18 },
});
const whisper = row("openai-compatible/whisper-large-v3", {
  currency: "EUR",
  perAudioSecond: 0.00005,
});
const glm = row("openai-compatible/glm-5.3", { currency: "EUR", inputPerM: 1.8, outputPerM: 5.5 });

const snap: PriceSnapshot = {
  prices: new Map([gemini, pro, whisper, glm].map((r) => [`${r.provider}/${r.model}`, r])),
  usdToEur: 0.9,
};

describe("priceCall", () => {
  test("text, audio and output tokens at their own rates, dollars to euros, rounded up", () => {
    const cost = priceCall(
      call({ inputTokens: 2000, cachedInputTokens: 0, audioInputTokens: 960, outputTokens: 1600 }),
      snap,
    );
    // ceil((1040*0.75 + 960*0.75 + 1600*3.75) / 1e6 * 0.9 * 1e6)
    expect(cost).toEqual({ costMicroEur: 6750, priceId: gemini.id, priceMissing: false });
  });

  test("cached tokens are priced at the cached rate", () => {
    const cost = priceCall(
      call({
        inputTokens: 2000,
        cachedInputTokens: 1000,
        audioInputTokens: 960,
        outputTokens: 1600,
      }),
      snap,
    );
    // text 40, cached 1000, audio 960
    expect(cost.costMicroEur).toBe(
      Math.ceil((40 * 0.75 + 1000 * 0.075 + 960 * 0.75 + 1600 * 3.75) * 0.9),
    );
  });

  test("cached and audio overlapping past the input total never price a token twice", () => {
    const c = call({
      inputTokens: 1000,
      cachedInputTokens: 800,
      audioInputTokens: 600,
      outputTokens: 0,
    });
    const cost = priceCall(c, snap).costMicroEur;
    const everyInputAtHighest = Math.ceil(1000 * Math.max(0.75, 0.075, 0.75) * 0.9);
    expect(cost).toBeLessThanOrEqual(everyInputAtHighest);
    // cached first (800), audio only what is left (200), no text
    expect(cost).toBe(Math.ceil((800 * 0.075 + 200 * 0.75) * 0.9));
  });

  test("a null cached or audio price falls back to the input price", () => {
    const cost = priceCall(
      call({
        model: "glm-5.3",
        provider: "openai-compatible",
        inputTokens: 1000,
        cachedInputTokens: 400,
      }),
      snap,
    );
    expect(cost.costMicroEur).toBe(1800);
  });

  test("above the long-context threshold the long prices apply to the whole call", () => {
    const c = call({
      model: "gemini-3.1-pro-preview",
      inputTokens: 250000,
      cachedInputTokens: 50000,
      outputTokens: 1000,
    });
    expect(priceCall(c, snap).costMicroEur).toBe(
      Math.ceil((200000 * 4 + 50000 * 0.4 + 1000 * 18) * 0.9),
    );
    const under = call({
      model: "gemini-3.1-pro-preview",
      inputTokens: 200000,
      outputTokens: 1000,
    });
    expect(priceCall(under, snap).costMicroEur).toBe(Math.ceil((200000 * 2 + 1000 * 12) * 0.9));
  });

  test("speech is priced per audio second, euros as they are", () => {
    const cost = priceCall(
      call({
        provider: "openai-compatible",
        model: "whisper-large-v3",
        kind: "speech",
        audioSeconds: 30,
      }),
      snap,
    );
    expect(cost).toEqual({ costMicroEur: 1500, priceId: whisper.id, priceMissing: false });
  });

  test("search lookups add their price per query", () => {
    const base = {
      inputTokens: 2000,
      cachedInputTokens: 0,
      audioInputTokens: 960,
      outputTokens: 1600,
    };
    const cost = priceCall(call({ ...base, searchQueries: 2 }), snap);
    expect(cost.costMicroEur).toBe(6750 + 25200);
  });

  test("an unknown model is charged the highest price per unit and flagged", () => {
    const c = call({
      model: "gemini-9",
      inputTokens: 1000,
      outputTokens: 1000,
      audioSeconds: 10,
      searchQueries: 1,
    });
    const cost = priceCall(c, snap);
    expect(cost.priceMissing).toBe(true);
    expect(cost.priceId).toBeNull();
    expect(cost.costMicroEur).toBeGreaterThan(0);
    // highest held: input 4 USD (long tier), output 18 USD (long tier), 0.00005 EUR/s, 0.014 USD/query
    expect(cost.costMicroEur).toBe(
      Math.ceil(1000 * 4 * 0.9 + 1000 * 18 * 0.9 + 10 * 0.00005 * 1e6 + 0.014 * 0.9 * 1e6),
    );
  });

  test("a call with no usage at all costs nothing and is not flagged", () => {
    expect(priceCall(call({ status: "error" }), snap)).toEqual({
      costMicroEur: 0,
      priceId: null,
      priceMissing: false,
    });
    expect(priceCall(call({ model: "gemini-9", status: "error" }), snap).priceMissing).toBe(false);
  });
});
