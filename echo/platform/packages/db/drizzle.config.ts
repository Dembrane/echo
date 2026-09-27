import { defineConfig } from "drizzle-kit";

// The migration chain. Generated SQL is reviewed like code before merge, and every
// migration must be compatible with the release before it (expand, then contract).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: undefined,
  strict: true,
  verbose: true,
});
