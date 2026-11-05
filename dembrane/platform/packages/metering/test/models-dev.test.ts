import { describe, expect, test } from "bun:test";
import { environments, schema } from "@dembrane/config";
import { PROFILES } from "@dembrane/llm";
import { loadOverrides, type OverrideFile } from "../src/prices/book";
import { pricesFromModelsDev } from "../src/prices/models-dev";
import fixture from "./fixtures/models-dev.json";

const mapping: OverrideFile["models"] = {
  "vertex/gemini-3.8-flash": { provider: "vertex", modelsDev: "google-vertex/gemini-3.8-flash" },
  "vertex/gemini-3.1-pro-preview": {
    provider: "vertex",
    modelsDev: "google-vertex/gemini-3.1-pro-preview",
  },
  "vertex/gemini-0": { provider: "vertex", modelsDev: "google-vertex/gemini-0" },
  "openai-compatible/glm-5.3": {
    provider: "openai-compatible",
    prices: {
      currency: "EUR",
      inputPerM: 1.8,
      cachedInputPerM: null,
      audioInputPerM: null,
      outputPerM: 5.5,
      longContext: null,
      perAudioSecond: null,
      perSearchQuery: null,
    },
  },
};

describe("pricesFromModelsDev", () => {
  const prices = pricesFromModelsDev(fixture, mapping);

  test("maps a Vertex model's cost to unit prices in dollars", () => {
    expect(prices.get("vertex/gemini-3.8-flash")).toEqual({
      currency: "USD",
      inputPerM: 0.75,
      cachedInputPerM: 0.075,
      audioInputPerM: 0.75,
      outputPerM: 3.75,
      longContext: null,
      perAudioSecond: null,
      perSearchQuery: null,
    });
  });

  test("maps the over-200k context tier to long-context prices", () => {
    expect(prices.get("vertex/gemini-3.1-pro-preview")?.longContext).toEqual({
      threshold: 200000,
      inputPerM: 4,
      cachedInputPerM: 0.4,
      outputPerM: 18,
    });
  });

  test("leaves out models models.dev does not list and models priced by hand", () => {
    expect(prices.has("vertex/gemini-0")).toBe(false);
    expect(prices.has("openai-compatible/glm-5.3")).toBe(false);
    expect(prices.size).toBe(2);
  });

  test("an unreadable source yields nothing", () => {
    expect(pricesFromModelsDev(null, mapping).size).toBe(0);
    expect(pricesFromModelsDev({ "google-vertex": { models: 3 } }, mapping).size).toBe(0);
  });
});

// Mirrors the boot check: every model the config can call has an entry.
const configuredModels = (): Set<string> => {
  const out = new Set<string>();
  const llm = schema.llm;
  for (const file of Object.values(environments)) {
    const set = ((file as { llm?: Record<string, unknown> }).llm ?? {}) as Record<string, unknown>;
    const value = <K extends keyof typeof llm>(k: K) => llm[k].schema.parse(set[k]) as unknown;
    for (const k of ["textFast", "multiModalFast", "multiModalPro"] as const)
      for (const m of value(k) as string[]) out.add(`vertex/${m}`);
    out.add(`vertex/${value("embeddingModel")}`);
    for (const k of ["compatTextFast", "compatMultiModalFast", "compatMultiModalPro"] as const)
      for (const m of value(k) as string[]) out.add(`openai-compatible/${m}`);
    out.add(`openai-compatible/${value("compatEmbeddingModel")}`);
  }
  const speech = (p: { provider: string; model: string }) =>
    `${p.provider === "gemini" ? "vertex" : "openai-compatible"}/${p.model}`;
  for (const p of Object.values(PROFILES)) {
    out.add(speech(p.live));
    if (p.redo) out.add(speech(p.redo));
    if (p.cleanUp) out.add(`openai-compatible/${p.cleanUp.model}`);
  }
  return out;
};

describe("overrides.json", () => {
  const overrides = loadOverrides();

  test("names every model in the config defaults, environments and transcription profiles", () => {
    const models = configuredModels();
    expect(models.size).toBeGreaterThan(5);
    const missing = [...models].filter((m) => !overrides.models[m]);
    expect(missing).toEqual([]);
  });

  test("each entry's provider matches its key", () => {
    for (const [key, entry] of Object.entries(overrides.models))
      expect(key.startsWith(`${entry.provider}/`)).toBe(true);
  });

  test("every Vertex model it maps to models.dev is in the fixture", () => {
    const prices = pricesFromModelsDev(fixture, overrides.models);
    for (const [key, entry] of Object.entries(overrides.models))
      if ("modelsDev" in entry) expect(prices.has(key)).toBe(true);
  });

  test("search grounding is priced per query in dollars", () => {
    expect(overrides.searchQuery).toMatchObject({
      provider: "vertex",
      currency: "USD",
      perQuery: 0.014,
    });
  });
});
