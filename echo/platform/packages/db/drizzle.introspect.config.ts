import { defineConfig } from "drizzle-kit";

// Reads a live database into TypeScript. Point INTROSPECT_DATABASE_URL at a restored
// schema-only copy, never at prod. Output is reviewed by hand before it enters src/schema.
export default defineConfig({
  dialect: "postgresql",
  out: "./introspected",
  dbCredentials: { url: process.env.INTROSPECT_DATABASE_URL ?? "" },
  schemaFilter: ["public"],
  introspect: { casing: "preserve" },
});
