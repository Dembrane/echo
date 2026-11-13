import { expect, test } from "bun:test";
import { DIGEST_SCHEMA } from "../src/setup/digest-model";
import { SETUP_SCHEMA } from "../src/setup/model";

// Vertex rejects a response schema that carries these keywords, which fails every real
// call while tests on a fake model stay green. Sizes are checked in code instead.
const REJECTED = ["maxItems", "maxLength"];

for (const [name, schema] of Object.entries({ DIGEST_SCHEMA, SETUP_SCHEMA })) {
  test(`${name} has no size keywords Vertex rejects`, () => {
    const text = JSON.stringify(schema);
    for (const keyword of REJECTED) expect(text).not.toContain(`"${keyword}"`);
  });
}
