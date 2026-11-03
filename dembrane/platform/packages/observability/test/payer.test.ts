import { expect, test } from "bun:test";
import { payer, payerKey, withPayer } from "../src";

test("payer is undefined outside any scope", () => {
  expect(payer()).toBeUndefined();
});

test("payer survives await and setTimeout inside the scope", async () => {
  const p = { ref: "project", id: "p1" } as const;
  await withPayer(p, async () => {
    expect(payer()).toEqual(p);
    await Promise.resolve();
    expect(payer()).toEqual(p);
    const later = await new Promise((resolve) => setTimeout(() => resolve(payer()), 0));
    expect(later).toEqual(p);
  });
  expect(payer()).toBeUndefined();
});

test("a nested scope wins inside and the outer payer returns after it", () => {
  const outer = { ref: "project", id: "p1" } as const;
  const inner = { internal: "demo_build" };
  withPayer(outer, () => {
    withPayer(inner, () => expect(payer()).toEqual(inner));
    expect(payer()).toEqual(outer);
  });
});

test("payerKey names the ref kind or the internal reason", () => {
  expect(payerKey({ ref: "chat", id: "c" })).toBe("chat:c");
  expect(payerKey({ internal: "demo_build" })).toBe("internal:demo_build");
});
