import { expect, describe as group, test } from "bun:test";
import { z } from "zod";
import { schema as appSchema, loadConfig } from "../src";
import { defineSchema, key } from "../src/define";
import { ConfigError, describe, load, publicValues } from "../src/load";

const schema = defineSchema({
  http: {
    port: key("PORT", z.coerce.number().int().default(8080), { description: "port" }),
    publicUrl: key("PUBLIC_URL", z.url(), { description: "url", public: true }),
  },
  db: { url: key("DATABASE_URL", z.url(), { description: "db", secret: true }) },
});

const env = { DATABASE_URL: "postgres://u:p@h/db" };

group("load", () => {
  test("process env beats the environment file, which beats the default", () => {
    const file = { http: { port: 9000, publicUrl: "https://file.example" } };
    const { values, resolved } = load(schema, file, { ...env, PORT: "7000" });
    expect(values.http.port).toBe(7000);
    expect(values.http.publicUrl).toBe("https://file.example");
    expect(resolved.find((r) => r.path === "http.port")?.source).toBe("process-env");
    expect(resolved.find((r) => r.path === "http.publicUrl")?.source).toBe("environment-file");
  });

  test("reports every problem at once", () => {
    try {
      load(schema, {}, { PORT: "not-a-number" });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const problems = (e as ConfigError).problems;
      expect(problems).toHaveLength(3);
      expect(problems.join("\n")).toContain("PUBLIC_URL): missing");
      expect(problems.join("\n")).toContain("DATABASE_URL): missing");
    }
  });

  test("refuses a secret set in an environment file", () => {
    expect(() =>
      load(
        schema,
        { db: { url: "postgres://leak@h/db" }, http: { publicUrl: "https://x.example" } },
        env,
      ),
    ).toThrow("must not be set in an environment file");
  });

  test("values are frozen", () => {
    const { values } = load(schema, { http: { publicUrl: "https://x.example" } }, env);
    expect(Object.isFrozen(values.http)).toBe(true);
  });

  test("describe redacts secrets and publicValues exposes only public keys", () => {
    const loaded = load(schema, { http: { publicUrl: "https://x.example" } }, env);
    expect(describe(loaded)["db.url"]?.value).toBe("<set>");
    expect(publicValues(loaded)).toEqual({ http: { publicUrl: "https://x.example" } });
  });

  test("a variable declared twice is rejected at definition", () => {
    expect(() =>
      defineSchema({
        a: key("X", z.string(), { description: "a" }),
        b: key("X", z.string(), { description: "b" }),
      }),
    ).toThrow("declared twice");
  });

  test("a secret cannot be public", () => {
    expect(() => key("S", z.string(), { description: "s", secret: true, public: true })).toThrow();
  });
});

group("keys set together", () => {
  const grouped = defineSchema({
    inbox: {
      url: key("INBOX_URL", z.url().optional(), { description: "u" }),
      secret: key("INBOX_SECRET", z.string().optional(), { description: "s", secret: true }),
      from: key("INBOX_FROM", z.string().optional(), { description: "f" }),
    },
  });
  const rule = [["inbox.url", "inbox.secret", "inbox.from"]];
  const all = { INBOX_URL: "https://sam.example/inbox", INBOX_SECRET: "x", INBOX_FROM: "api" };

  test("all set or none set loads", () => {
    expect(load(grouped, {}, all, rule).values.inbox.from).toBe("api");
    expect(load(grouped, {}, {}, rule).values.inbox.url).toBeUndefined();
  });

  test("a partial set names the missing keys", () => {
    expect(() => load(grouped, {}, { INBOX_URL: all.INBOX_URL }, rule)).toThrow(
      "INBOX_URL, INBOX_SECRET, INBOX_FROM are set together or not at all; missing INBOX_SECRET, INBOX_FROM",
    );
    expect(() => load(grouped, {}, { ...all, INBOX_FROM: undefined }, rule)).toThrow(
      "missing INBOX_FROM",
    );
  });

  test("a group outside the loaded sections is not checked", () => {
    expect(() =>
      load(schema, { http: { publicUrl: "https://x.example" } }, env, rule),
    ).not.toThrow();
  });
});

group("sam's inbox", () => {
  const base = {
    APP_ENV: "test",
    DATABASE_URL: "postgres://u@h/d",
    AUTH_SECRET: "s".repeat(48),
    INVITE_HASH_SECRET: "i".repeat(32),
  };
  const inbox = {
    SAM_INBOX_URL: "https://sam-inbox.example/inbox",
    SAM_INBOX_SECRET: "k".repeat(48),
    SAM_INBOX_FROM: "api.staging.dembrane.com",
  };

  test("is off when none of its keys is set, on when all three are", () => {
    expect(loadConfig(base).values.samInbox.url).toBeUndefined();
    expect(loadConfig({ ...base, ...inbox }).values.samInbox).toEqual({
      url: inbox.SAM_INBOX_URL,
      secret: inbox.SAM_INBOX_SECRET,
      from: inbox.SAM_INBOX_FROM,
    });
  });

  for (const missing of Object.keys(inbox))
    test(`fails at boot without ${missing}`, () => {
      expect(() => loadConfig({ ...base, ...inbox, [missing]: undefined })).toThrow(
        `missing ${missing}`,
      );
    });

  test("the secret never comes from an environment file and is redacted", () => {
    const loaded = loadConfig({ ...base, ...inbox });
    expect(describe(loaded)["samInbox.secret"]?.value).toBe("<set>");
    expect(() =>
      load({ samInbox: appSchema.samInbox }, { samInbox: { secret: "k".repeat(48) } }, {}),
    ).toThrow("must not be set in an environment file");
  });

  test("a sender name with a newline is refused, since the signature joins fields by newline", () => {
    expect(() => loadConfig({ ...base, ...inbox, SAM_INBOX_FROM: "api\nother" })).toThrow();
  });
});
