import { expect, test } from "bun:test";
import { loadConfig, schema } from "../src";
import { walk } from "../src/define";

// Every deployed environment keeps customer data and telemetry in the EU. The infrastructure
// side (regions, log bucket, secret replicas) is in dembrane/infra/; these are the choices the
// application makes itself.
const secrets = Object.fromEntries(
  [...walk(schema)]
    .filter(([, k]) => k.meta.secret)
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
