import { expect, test } from "bun:test";
import { loadConfig, schema, together } from "../src";
import { walk } from "../src/define";

// Every deployed environment keeps customer data and telemetry in the EU. The infrastructure
// side (regions, log bucket, secret replicas) is in dembrane/infra/; these are the choices the
// application makes itself.
const secrets = Object.fromEntries(
  [...walk(schema)]
    .filter(([path, k]) => k.meta.secret && !together.flat().includes(path))
    .map(([, k]) => [
      k.meta.env,
      k.meta.env.endsWith("_URL") ? "postgres://u@h/d" : "s".repeat(48),
    ]),
);

for (const env of ["preview", "staging", "prod"] as const) {
  test(`${env} keeps data in the EU`, () => {
    const { values } = loadConfig({ APP_ENV: env, ...secrets });
    // Vertex's EU multi-region endpoint for generation, a European region for embeddings.
    expect(values.llm.vertexLocation).toBe("eu");
    expect(values.llm.embeddingLocation).toMatch(/^europe-/);
    expect(values.mail.sendgridRegion).toBe("eu");
    // Cloud Trace stores spans outside the EU, so nothing is exported and nothing recorded.
    expect(values.observability.otlpEndpoint).toBeUndefined();
    expect(values.observability.traceSampleRatio).toBe(0);
  });
}

test("providers default to today's, and the Scaleway switches load", () => {
  const { values } = loadConfig({ APP_ENV: "prod", ...secrets });
  expect(values.llm.provider).toBe("vertex");
  expect(values.mail.provider).toBe("sendgrid");
  expect(values.llm.searchGrounding).toBe(true);
  expect(values.web.analytics).toBeUndefined();
  expect(values.web.storageOrigins).toEqual([
    "https://storage.googleapis.com",
    "https://ams3.digitaloceanspaces.com",
  ]);
  const eu = loadConfig({
    APP_ENV: "prod",
    ...secrets,
    LLM_PROVIDER: "openai-compatible",
    LLM_BASE_URL: "https://api.scaleway.ai/v1",
    MAIL_PROVIDER: "scaleway",
    WEB_ANALYTICS: "false",
    WEB_STORAGE_ORIGINS: "https://*.s3.fr-par.scw.cloud",
  }).values;
  expect(eu.llm.compatMultiModalPro).toEqual(["glm-5.3"]);
  expect(eu.llm.compatEmbeddingModel).toBe("qwen3-embedding-8b");
  expect(eu.llm.transcriptionProfile).toBeUndefined();
  expect(eu.mail.provider).toBe("scaleway");
  expect(eu.web.analytics).toBe(false);
  expect(eu.web.storageOrigins).toEqual(["https://*.s3.fr-par.scw.cloud"]);
});
