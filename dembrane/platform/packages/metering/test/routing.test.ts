import { describe, expect, test } from "bun:test";
import { loadConfig } from "@dembrane/config";
import { decide, routingPolicyOf } from "@dembrane/llm";
import type { Payer } from "@dembrane/observability";
import {
  aiRouting,
  providerResolver,
  type RoutingFacts,
  type RoutingStore,
  resolveRouting,
} from "../src";

const policy = routingPolicyOf({
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
});
const ORG = "33333333-3333-4333-8333-333333333333";
const project = (id: string): Payer => ({ ref: "project", id });

const facts = (over: Partial<RoutingFacts> = {}): RoutingFacts => ({
  organisationId: ORG,
  allowed: ["scaleway", "google"],
  accountDefault: "scaleway",
  projectProvider: null,
  ...over,
});

/** A store whose answers a test changes between calls, and that counts how often it is asked. */
function store(initial: RoutingFacts | null | Error) {
  let now: RoutingFacts | null | Error = initial;
  const asked: string[] = [];
  const s: RoutingStore = {
    async facts(who) {
      asked.push(`${who.ref}:${who.id}`);
      if (now instanceof Error) throw now;
      return now;
    },
  };
  return {
    store: s,
    asked,
    set(next: RoutingFacts | null | Error) {
      now = next;
    },
  };
}

describe("the pure decision", () => {
  test("project choice, account default, and an account nobody set", () => {
    expect(resolveRouting(policy, facts({ projectProvider: "google" }))).toMatchObject({
      provider: "google",
      reason: "project",
      organisationId: ORG,
    });
    expect(resolveRouting(policy, facts({ accountDefault: "google" }))).toMatchObject({
      provider: "google",
      reason: "account-default",
    });
    expect(resolveRouting(policy, facts())).toMatchObject({
      provider: "scaleway",
      reason: "account-default",
    });
    expect(resolveRouting(policy, facts({ allowed: null, accountDefault: null }))).toMatchObject({
      provider: "scaleway",
      reason: "environment-default",
      allowed: ["scaleway"],
    });
  });

  test("an account that loses Google moves every project of it back at once", () => {
    const lost = facts({
      allowed: ["scaleway"],
      accountDefault: "scaleway",
      projectProvider: "google",
    });
    expect(resolveRouting(policy, lost)).toMatchObject({
      provider: "scaleway",
      reason: "account-default",
    });
    // Even where Google was its default.
    expect(
      resolveRouting(
        policy,
        facts({ allowed: ["scaleway"], accountDefault: "google", projectProvider: "google" }),
      ),
    ).toMatchObject({ provider: "scaleway" });
  });

  test("a provider the deployment lacks is never chosen, whatever the database says", () => {
    const only = routingPolicyOf({ provider: "openai-compatible" });
    expect(
      resolveRouting(only, facts({ projectProvider: "google", accountDefault: "google" })),
    ).toMatchObject({
      provider: "scaleway",
    });
    expect(
      resolveRouting(only, facts({ allowed: ["google"], accountDefault: "google" })),
    ).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:nothing-allowed",
    });
  });

  test("a conversation that began on Scaleway stays there when its project moves to Google", () => {
    const moved = facts({ projectProvider: "google" });
    expect(resolveRouting(policy, { ...moved, conversationProvider: "scaleway" })).toMatchObject({
      provider: "scaleway",
      reason: "conversation",
    });
    // One that began before providers were recorded counts as not on Google either.
    expect(resolveRouting(policy, { ...moved, conversationProvider: null })).toMatchObject({
      provider: "scaleway",
    });
    expect(resolveRouting(policy, { ...moved, conversationProvider: "google" })).toMatchObject({
      provider: "google",
      reason: "project",
    });
    // Going back to Scaleway applies to a conversation that began on Google.
    expect(resolveRouting(policy, { ...facts(), conversationProvider: "google" })).toMatchObject({
      provider: "scaleway",
    });
  });
});

describe("the resolver", () => {
  const ask = (r: ReturnType<typeof providerResolver>, who: Payer | undefined) =>
    decide(r, policy, who);

  test("everything it cannot read positively is the default", async () => {
    const s = store(facts({ projectProvider: "google" }));
    const r = providerResolver(s.store, policy);
    expect(await ask(r, undefined)).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:no-payer",
    });
    expect(await ask(r, { internal: "demo_build" })).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:internal",
    });
    expect(s.asked).toEqual([]);
    s.set(null);
    expect(await ask(r, project("p1"))).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:unknown-project",
    });
    s.set(new Error("database is down"));
    expect(await ask(r, project("p2"))).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:lookup-error",
    });
  });

  test("Google is read fresh every time; a switch back applies to the very next call", async () => {
    const s = store(facts({ projectProvider: "google" }));
    const r = providerResolver(s.store, policy);
    expect((await ask(r, project("p"))).provider).toBe("google");
    expect((await ask(r, project("p"))).provider).toBe("google");
    expect(s.asked).toHaveLength(2);
    s.set(facts({ projectProvider: "scaleway" }));
    expect((await ask(r, project("p"))).provider).toBe("scaleway");
    // An error after Google was served is the default, not the last answer.
    s.set(facts({ projectProvider: "google" }));
    expect((await ask(r, project("q"))).provider).toBe("google");
    s.set(new Error("down"));
    expect((await ask(r, project("q"))).provider).toBe("scaleway");
  });

  test("a Scaleway decision may be remembered, for a short while, and never turns into Google", async () => {
    let t = 1_000;
    const s = store(facts());
    const r = providerResolver(s.store, policy, { ttlMs: 30_000, now: () => t });
    expect((await ask(r, project("p"))).provider).toBe("scaleway");
    s.set(facts({ projectProvider: "google" }));
    t += 10_000;
    expect((await ask(r, project("p"))).provider).toBe("scaleway");
    expect(s.asked).toHaveLength(1);
    t += 25_000;
    expect((await ask(r, project("p"))).provider).toBe("google");
    expect(s.asked).toHaveLength(2);
  });

  test("with one provider the database is never asked, even if it says Google", async () => {
    const only = routingPolicyOf({ provider: "openai-compatible" });
    const s = store(facts({ projectProvider: "google", accountDefault: "google" }));
    const r = providerResolver(s.store, only);
    expect(await decide(r, only, project("p"))).toMatchObject({
      provider: "scaleway",
      reason: "only-provider",
    });
    expect(s.asked).toEqual([]);
  });
});

describe("an EU production style deployment", () => {
  const secrets = {
    AUTH_SECRET: "s".repeat(48),
    INVITE_HASH_SECRET: "s".repeat(48),
    DATABASE_URL: "postgres://u@h/d",
  };

  test("with only Scaleway configured it boots and routes everything there even if the database says Google", async () => {
    const { values } = loadConfig({
      APP_ENV: "prod",
      ...secrets,
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: "https://api.scaleway.ai/v1",
      LLM_API_KEY: "key",
      TRANSCRIPTION_PROFILE: "dembrane-26-10-whisper-eu",
    });
    const dbSaysGoogle = store(facts({ projectProvider: "google", accountDefault: "google" }));
    const ai = aiRouting({
      settings: values.llm,
      db: undefined as never,
      resolver: providerResolver(dbSaysGoogle.store, routingPolicyOf(values.llm)),
    });
    expect(ai.policy).toEqual({ providers: ["scaleway"], default: "scaleway" });
    expect(Object.keys(ai.registry)).toEqual(["scaleway"]);
    expect(await decide(ai.resolver, ai.policy, project("p"))).toMatchObject({
      provider: "scaleway",
    });
    expect(dbSaysGoogle.asked).toEqual([]);
  });

  test("listing Google without a Vertex project is a boot gap", async () => {
    const { bootGaps } = await import("@dembrane/llm");
    const { values } = loadConfig({
      APP_ENV: "prod",
      ...secrets,
      LLM_PROVIDER: "openai-compatible",
      LLM_PROVIDERS: "scaleway,google",
      LLM_BASE_URL: "https://api.scaleway.ai/v1",
      LLM_API_KEY: "key",
      LLM_VERTEX_PROJECT: "",
    });
    const ai = aiRouting({
      settings: values.llm,
      db: undefined as never,
      resolver: async () => {
        throw new Error("x");
      },
    });
    expect(bootGaps(values.llm, ai.policy, ai.profileOf)).toEqual([
      "provider google needs LLM_VERTEX_PROJECT, which is not set",
      "transcription profile dembrane-26-10-gemini needs LLM_VERTEX_PROJECT, which is not set",
    ]);
  });
});
