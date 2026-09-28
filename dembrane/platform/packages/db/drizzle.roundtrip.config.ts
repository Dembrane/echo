import { defineConfig } from "drizzle-kit";

// Round-trip check: regenerate SQL from the introspected schema so it can be applied
// to an empty database and compared with the source it was read from.
export default defineConfig({
  dialect: "postgresql",
  schema: process.env.ROUNDTRIP_SCHEMA ?? "./introspected/schema.ts",
  out: process.env.ROUNDTRIP_OUT ?? "./.roundtrip",
});
