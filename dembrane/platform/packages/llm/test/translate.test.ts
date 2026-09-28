import { expect, test } from "bun:test";
import { FakeCompleter, translateTexts } from "../src";

test("translates in batches, keeps order, and leaves a failed batch's texts null", async () => {
  const fake = new FakeCompleter().on("translate", (r) => {
    const payload = JSON.parse(r.user as string) as {
      target: string;
      glossary: Record<string, string>;
      texts: { i: number; text: string; note?: string }[];
    };
    if (payload.texts.some((t) => t.text === "boom")) throw new Error("vertex 503");
    return JSON.stringify({
      translations: payload.texts.map((t) => ({ i: t.i, text: `${payload.target}:${t.text}` })),
    });
  });
  const warnings: string[] = [];
  const out = await translateTexts(fake, ["a", "b", "c", "boom"], {
    system: "translate these",
    target: "Dutch",
    batch: 2,
    parallel: 2,
    extra: { glossary: { workspace: "werkruimte" } },
    notes: ["first", undefined, undefined, undefined],
    warn: (m) => warnings.push(m),
  });
  expect(out).toEqual(["Dutch:a", "Dutch:b", null, null]);
  expect(warnings).toEqual(["vertex 503"]);
  const first = JSON.parse(fake.calls[0]?.user as string);
  expect(first.glossary).toEqual({ workspace: "werkruimte" });
  expect(first.texts[0]).toEqual({ i: 0, text: "a", note: "first" });
  expect(fake.calls[0]?.jsonSchema).toBeDefined();
});
