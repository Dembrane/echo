import { describe, expect, test } from "bun:test";
import { checkOverrides, loadOverrides } from "../src/prices/book";

const priced = (prices: Record<string, unknown>) => ({
  models: {
    "openai-compatible/whisper-large-v3": {
      provider: "openai-compatible",
      prices: {
        currency: "EUR",
        inputPerM: null,
        cachedInputPerM: null,
        audioInputPerM: null,
        outputPerM: null,
        longContext: null,
        perAudioSecond: 0.00005,
        perSearchQuery: null,
        ...prices,
      },
    },
  },
  searchQuery: { provider: "vertex", currency: "USD", perQuery: 0.014 },
});

describe("prices/overrides.json", () => {
  test("the kept file passes", () => {
    expect(() => loadOverrides()).not.toThrow();
  });

  test("a valid hand price passes", () => {
    expect(() => checkOverrides(priced({}))).not.toThrow();
  });

  test("a misspelt unit key is refused, not priced at 0", () => {
    const f = priced({ perAudioSeconds: 0.00005 });
    delete (f.models["openai-compatible/whisper-large-v3"].prices as Record<string, unknown>)
      .perAudioSecond;
    expect(() => checkOverrides(f)).toThrow(/whisper-large-v3/);
  });

  test("an unknown key next to the right ones is refused", () => {
    expect(() => checkOverrides(priced({ perImage: 0.01 }))).toThrow(/perImage/);
  });

  test("a unit price that is not a number or null is refused", () => {
    expect(() => checkOverrides(priced({ outputPerM: "5.5" }))).toThrow(/outputPerM/);
  });

  test("a hand price with no unit above 0 is refused", () => {
    expect(() => checkOverrides(priced({ perAudioSecond: null }))).toThrow(/whisper-large-v3/);
  });

  test("a long-context tier needs numbers for its threshold and prices", () => {
    expect(() =>
      checkOverrides(
        priced({
          longContext: { threshold: 200_000, inputPerM: 2, outputPerM: 4, cachedInput: 1 },
        }),
      ),
    ).toThrow(/longContext/);
    expect(() =>
      checkOverrides(
        priced({
          longContext: { threshold: 200_000, inputPerM: 2, cachedInputPerM: null, outputPerM: 4 },
        }),
      ),
    ).not.toThrow();
  });

  test("an unknown key on a model entry is refused", () => {
    const f = priced({});
    (f.models["openai-compatible/whisper-large-v3"] as Record<string, unknown>).model = "x";
    expect(() => checkOverrides(f)).toThrow(/model/);
  });
});
