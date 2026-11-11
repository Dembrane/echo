import { describe, expect, test } from "bun:test";
import { missingPriceText } from "../src";

const listed = new Set(["vertex/gemini-3.8-flash", "vertex/gemini-3.7-flash"]);

describe("the startup post for models without a price", () => {
  test("models.dev unreadable: the next sync prices a mapped model, no hand price asked for", () => {
    const text = missingPriceText(["vertex/gemini-3.8-flash"], {
      listed,
      sync: "unread",
      held: false,
    });
    expect(text).toBe(
      "No AI price for vertex/gemini-3.8-flash: models.dev could not be read, so the next sync prices them. Until then their calls are charged at the highest price held.",
    );
  });

  test("models.dev read but missing the model: a hand price is the fix", () => {
    expect(
      missingPriceText(["vertex/gemini-3.7-flash"], { listed, sync: "read", held: false }),
    ).toContain(
      "models.dev does not list them, so give them a hand price in prices/overrides.json.",
    );
  });

  test("a model with no overrides entry is named apart from the mapped ones", () => {
    const text = missingPriceText(["vertex/x", "vertex/gemini-3.8-flash"], {
      listed,
      sync: "failed",
      held: false,
    });
    expect(text).toContain(
      "No AI price for vertex/x: not in prices/overrides.json, so add an entry there.",
    );
    expect(text).toContain(
      "No AI price for vertex/gemini-3.8-flash: the startup price sync failed, so the next sync prices them.",
    );
  });

  test("with no prices stored at all, calls are said to be held, not charged", () => {
    const text = missingPriceText(["vertex/gemini-3.8-flash"], {
      listed,
      sync: "failed",
      held: true,
    });
    expect(text).toContain("calls with usage are held, not charged, until prices load");
    expect(text).not.toContain("highest price");
  });

  test("no em dash in any variant", () => {
    for (const sync of ["read", "unread", "failed"] as const)
      for (const held of [true, false])
        expect(
          missingPriceText(["vertex/x", "vertex/gemini-3.8-flash"], { listed, sync, held }),
        ).not.toContain("—");
  });
});
