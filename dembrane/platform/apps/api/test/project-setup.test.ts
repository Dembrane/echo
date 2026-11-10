import { expect, test } from "bun:test";
import { loadConfig } from "@dembrane/config";
import { projectSetupWebSearch } from "../src/app";

// ECHO-1043: setup suggestions look the host's organisation up with search only when
// PROJECT_SETUP_WEB_SEARCH is on and the provider grounds with search.
const config = (env: Record<string, string>) =>
  loadConfig({
    APP_ENV: "test",
    DATABASE_URL: "postgres://u@h/d",
    AUTH_SECRET: "s".repeat(48),
    INVITE_HASH_SECRET: "i".repeat(32),
    ...env,
  }).values;

test("off by default", () => {
  expect(config({}).projects.setupWebSearch).toBe(false);
  expect(projectSetupWebSearch(config({}))).toBe(false);
});

test("on only with the flag and search grounding", () => {
  expect(projectSetupWebSearch(config({ PROJECT_SETUP_WEB_SEARCH: "true" }))).toBe(true);
  expect(
    projectSetupWebSearch(
      config({ PROJECT_SETUP_WEB_SEARCH: "true", LLM_SEARCH_GROUNDING: "false" }),
    ),
  ).toBe(false);
});
