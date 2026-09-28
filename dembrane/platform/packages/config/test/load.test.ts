import { expect, describe as group, test } from "bun:test";
import { z } from "zod";
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
