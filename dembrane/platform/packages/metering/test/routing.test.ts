import { describe, expect, test } from "bun:test";
import { loadConfig } from "@dembrane/config";
import {
  decide,
  isProviderId,
  JOBS,
  type Job,
  PROVIDERS,
  type ProviderId,
  type ProviderResolver,
  routingPolicyOf,
  serves,
} from "@dembrane/llm";
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

/** An account with both providers enabled for both jobs and Scaleway as the default of each. */
const facts = (over: Partial<RoutingFacts> = {}): RoutingFacts => ({
  organisationId: ORG,
  enabled: { transcription: ["scaleway", "google"], analysis: ["scaleway", "google"] },
  defaults: { transcription: "scaleway", analysis: "scaleway" },
  projectChoices: { transcription: null, analysis: null },
  ...over,
});

/** The facts of a project that chose Google for the given jobs. */
const choosing = (...jobs: Job[]): Partial<RoutingFacts> => ({
  projectChoices: {
    transcription: jobs.includes("transcription") ? "google" : null,
    analysis: jobs.includes("analysis") ? "google" : null,
  },
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
    expect(resolveRouting(policy, facts(choosing("analysis")), "analysis")).toMatchObject({
      provider: "google",
      job: "analysis",
      reason: "project",
      organisationId: ORG,
    });
    expect(
      resolveRouting(
        policy,
        facts({ defaults: { transcription: "scaleway", analysis: "google" } }),
        "analysis",
      ),
    ).toMatchObject({ provider: "google", reason: "account-default" });
    expect(resolveRouting(policy, facts(), "analysis")).toMatchObject({
      provider: "scaleway",
      reason: "account-default",
    });
    expect(
      resolveRouting(
        policy,
        facts({
          enabled: { transcription: null, analysis: null },
          defaults: { transcription: null, analysis: null },
        }),
        "transcription",
      ),
    ).toMatchObject({
      provider: "scaleway",
      reason: "environment-default",
      allowed: ["scaleway"],
    });
  });

  test("each job follows its own choice: transcription on Google with analysis on Scaleway, and back", () => {
    const f = facts(choosing("transcription"));
    expect(resolveRouting(policy, f, "transcription").provider).toBe("google");
    expect(resolveRouting(policy, f, "analysis").provider).toBe("scaleway");
    const g = facts(choosing("analysis"));
    expect(resolveRouting(policy, g, "transcription").provider).toBe("scaleway");
    expect(resolveRouting(policy, g, "analysis").provider).toBe("google");
  });

  test("a provider enabled for one job only is never chosen for the other", () => {
    const analysisOnly = facts({
      enabled: { transcription: ["scaleway"], analysis: ["scaleway", "google"] },
      defaults: { transcription: "google", analysis: "google" },
      ...choosing("transcription", "analysis"),
    });
    expect(resolveRouting(policy, analysisOnly, "analysis").provider).toBe("google");
    expect(resolveRouting(policy, analysisOnly, "transcription")).toMatchObject({
      provider: "scaleway",
      allowed: ["scaleway"],
    });
  });

  test("an account that loses Google for a job moves every project of it back at once", () => {
    const lost = facts({
      enabled: { transcription: ["scaleway", "google"], analysis: ["scaleway"] },
      defaults: { transcription: "scaleway", analysis: "scaleway" },
      ...choosing("transcription", "analysis"),
    });
    expect(resolveRouting(policy, lost, "analysis")).toMatchObject({
      provider: "scaleway",
      reason: "account-default",
    });
    // The other job keeps its choice.
    expect(resolveRouting(policy, lost, "transcription").provider).toBe("google");
    // Even where Google was its default.
    expect(
      resolveRouting(
        policy,
        facts({
          enabled: { transcription: ["scaleway"], analysis: ["scaleway"] },
          defaults: { transcription: "google", analysis: "google" },
          ...choosing("transcription", "analysis"),
        }),
        "analysis",
      ),
    ).toMatchObject({ provider: "scaleway" });
  });

  test("a provider the deployment lacks is never chosen, whatever the database says", () => {
    const only = routingPolicyOf({ provider: "openai-compatible" });
    const wantsGoogle = facts({
      defaults: { transcription: "google", analysis: "google" },
      ...choosing("transcription", "analysis"),
    });
    for (const job of JOBS)
      expect(resolveRouting(only, wantsGoogle, job)).toMatchObject({ provider: "scaleway" });
    expect(
      resolveRouting(
        only,
        facts({
          enabled: { transcription: ["google"], analysis: ["google"] },
          defaults: { transcription: "google", analysis: "google" },
        }),
        "analysis",
      ),
    ).toMatchObject({ provider: "scaleway", reason: "fail-closed:nothing-allowed" });
  });

  test("a conversation that began on Scaleway keeps its audio there when its project moves to Google", () => {
    const moved = facts(choosing("transcription", "analysis"));
    expect(
      resolveRouting(policy, { ...moved, conversationProvider: "scaleway" }, "transcription"),
    ).toMatchObject({ provider: "scaleway", reason: "conversation" });
    // One that began before providers were recorded counts as not on Google either.
    expect(
      resolveRouting(policy, { ...moved, conversationProvider: null }, "transcription"),
    ).toMatchObject({ provider: "scaleway" });
    expect(
      resolveRouting(policy, { ...moved, conversationProvider: "google" }, "transcription"),
    ).toMatchObject({ provider: "google", reason: "project" });
    // Going back to Scaleway applies to a conversation that began on Google.
    expect(
      resolveRouting(policy, { ...facts(), conversationProvider: "google" }, "transcription"),
    ).toMatchObject({ provider: "scaleway" });
  });

  test("the conversation's start binds transcription only: analysis decides at every call", () => {
    const moved = {
      ...facts(choosing("transcription", "analysis")),
      conversationProvider: "scaleway",
    };
    expect(resolveRouting(policy, moved, "analysis")).toMatchObject({
      provider: "google",
      reason: "project",
    });
    expect(resolveRouting(policy, moved, "transcription").provider).toBe("scaleway");
  });
});

/** A small seeded generator, so a failing case can be replayed. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE = ["scaleway", "google", "google", "nowhere", "", "GOOGLE", "orai", null] as const;

describe("properties over random accounts, project choices and failures", () => {
  const draw = (r: () => number) => {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const list = (): string[] | null =>
      r() < 0.15 ? null : Array.from({ length: Math.floor(r() * 4) }, () => pick(NOISE) as string);
    const one = () => pick(NOISE) as string | null;
    const f: RoutingFacts = {
      organisationId: ORG,
      enabled: { transcription: list(), analysis: list() },
      defaults: { transcription: one(), analysis: one() },
      projectChoices: { transcription: one(), analysis: one() },
      ...(r() < 0.5 && { conversationProvider: one(), conversationId: "c" }),
    };
    return { f, job: pick(JOBS) };
  };

  test("never a provider the account has not enabled for the job, nor one that does not serve it", () => {
    const r = rng(20261125);
    for (let i = 0; i < 4000; i++) {
      const { f, job } = draw(r);
      const d = resolveRouting(policy, f, job);
      expect(d.job).toBe(job);
      expect(policy.providers.includes(d.provider)).toBe(true);
      expect(serves(d.provider, job)).toBe(true);
      const enabled = (f.enabled[job] ?? [policy.default]).filter(isProviderId);
      // Fail closed lands on the environment default; every other answer is an enabled provider.
      if (!d.reason.startsWith("fail-closed")) expect(enabled).toContain(d.provider);
      // Google is only ever the answer when the account enabled it for this very job.
      if (d.provider === "google") {
        expect(enabled).toContain("google");
        if (job === "transcription" && f.conversationProvider !== undefined)
          expect(f.conversationProvider).toBe("google");
      }
    }
  });

  test("the same holds when a provider serves only some jobs", () => {
    // The catalog is data: a provider that hears audio and reads no text, as Orai will.
    const google = PROVIDERS.google as { jobs: readonly Job[] };
    const original = google.jobs;
    google.jobs = ["transcription"];
    try {
      const r = rng(7);
      for (let i = 0; i < 2000; i++) {
        const { f, job } = draw(r);
        const d = resolveRouting(policy, f, job);
        expect(serves(d.provider, job)).toBe(true);
        if (job === "analysis") expect(d.provider).toBe("scaleway");
      }
    } finally {
      google.jobs = original;
    }
  });

  test("through the resolver, a failing store or a hostile answer is the environment default", async () => {
    const r = rng(99);
    for (let i = 0; i < 400; i++) {
      const { f, job } = draw(r);
      const mode = r();
      const s = store(mode < 0.2 ? new Error("down") : mode < 0.35 ? null : f);
      const resolver = providerResolver(s.store, policy, { ttlMs: 0 });
      const d = await decide(resolver, policy, job, project("p"));
      expect(d.job).toBe(job);
      expect(serves(d.provider, job)).toBe(true);
      if (mode < 0.35) expect(d).toMatchObject({ provider: "scaleway" });
    }
    // A resolver that answers for the wrong job, or for a provider that is not there.
    const wrongJob: ProviderResolver = async (_who, job) => ({
      provider: "google",
      job: job === "analysis" ? "transcription" : "analysis",
      organisationId: ORG,
      reason: "project",
      allowed: null,
    });
    for (const job of JOBS)
      expect(await decide(wrongJob, policy, job, project("p"))).toMatchObject({
        provider: "scaleway",
        reason: "fail-closed:provider-missing",
      });
  });
});

describe("the resolver", () => {
  const ask = (
    r: ReturnType<typeof providerResolver>,
    who: Payer | undefined,
    job: Job = "analysis",
  ) => decide(r, policy, job, who);

  test("everything it cannot read positively is the default, for each job", async () => {
    const s = store(facts(choosing("analysis", "transcription")));
    const r = providerResolver(s.store, policy);
    for (const job of JOBS) {
      expect(await ask(r, undefined, job)).toMatchObject({
        provider: "scaleway",
        job,
        reason: "fail-closed:no-payer",
      });
      expect(await ask(r, { internal: "demo_build" }, job)).toMatchObject({
        provider: "scaleway",
        reason: "fail-closed:internal",
      });
    }
    expect(s.asked).toEqual([]);
    s.set(null);
    expect(await ask(r, project("p1"))).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:unknown-project",
    });
    s.set(new Error("database is down"));
    expect(await ask(r, project("p2"), "transcription")).toMatchObject({
      provider: "scaleway",
      reason: "fail-closed:lookup-error",
    });
  });

  test("Google is read fresh every time; a switch back applies to the very next call", async () => {
    const s = store(facts(choosing("analysis")));
    const r = providerResolver(s.store, policy);
    expect((await ask(r, project("p"))).provider).toBe("google");
    expect((await ask(r, project("p"))).provider).toBe("google");
    expect(s.asked).toHaveLength(2);
    s.set(facts());
    expect((await ask(r, project("p"))).provider).toBe("scaleway");
    // An error after Google was served is the default, not the last answer.
    s.set(facts(choosing("analysis")));
    expect((await ask(r, project("q"))).provider).toBe("google");
    s.set(new Error("down"));
    expect((await ask(r, project("q"))).provider).toBe("scaleway");
  });

  test("a Scaleway decision may be remembered per job, for a short while, and never turns into Google", async () => {
    let t = 1_000;
    const s = store(facts());
    const r = providerResolver(s.store, policy, { ttlMs: 30_000, now: () => t });
    expect((await ask(r, project("p"))).provider).toBe("scaleway");
    s.set(facts(choosing("analysis", "transcription")));
    t += 10_000;
    expect((await ask(r, project("p"))).provider).toBe("scaleway");
    expect(s.asked).toHaveLength(1);
    // The other job was never asked, so it reads fresh and finds Google.
    expect((await ask(r, project("p"), "transcription")).provider).toBe("google");
    t += 25_000;
    expect((await ask(r, project("p"))).provider).toBe("google");
    expect(s.asked).toHaveLength(3);
  });

  test("with one provider the database is never asked, even if it says Google", async () => {
    const only = routingPolicyOf({ provider: "openai-compatible" });
    const s = store(
      facts({ defaults: { transcription: "google", analysis: "google" }, ...choosing("analysis") }),
    );
    const r = providerResolver(s.store, only);
    for (const job of JOBS)
      expect(await decide(r, only, job, project("p"))).toMatchObject({
        provider: "scaleway",
        job,
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
    const dbSaysGoogle = store(
      facts({ defaults: { transcription: "google", analysis: "google" }, ...choosing("analysis") }),
    );
    const ai = aiRouting({
      settings: values.llm,
      db: undefined as never,
      resolver: providerResolver(dbSaysGoogle.store, routingPolicyOf(values.llm)),
    });
    expect(ai.policy).toEqual({ providers: ["scaleway"], default: "scaleway" });
    expect(Object.keys(ai.registry)).toEqual(["scaleway"]);
    for (const job of JOBS)
      expect(await decide(ai.resolver, ai.policy, job, project("p"))).toMatchObject({
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
