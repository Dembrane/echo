import { expect, test } from "bun:test";
import { join } from "node:path";

// The preload is wired by bunfig.toml at the platform root, so the child runs from there.
const root = join(import.meta.dir, "..");

test("the preload fails a test with an unscoped AI call or an observer fault", () => {
  const run = Bun.spawnSync(
    [process.execPath, "test", "./scripts/fixtures/test-preload.fixture.ts"],
    {
      cwd: root,
      env: process.env,
    },
  );
  const out = run.stdout.toString() + run.stderr.toString();
  expect(out).toContain(
    "AI call without a payer scope in this test: generate fake/multi_modal_pro. Wrap the entry point in withPayer, or scope the test.",
  );
  expect(out).toContain("AI call without a payer scope in this test: generate fake/text_fast.");
  expect(out).toContain("metering is broken");
  expect(out).toMatch(/\(fail\) unscoped model call/);
  expect(out).toMatch(/\(fail\) unscoped completer call/);
  expect(out).not.toContain("(fail) scoped calls");
  expect(out).toMatch(/\(fail\) observer fault/);
  expect(out).toMatch(/\(fail\) the next fault reaches its sink again/);
  // It fails for the fault alone: the reset let that fault reach its sink.
  expect(out).not.toContain("toHaveLength");
  expect(out).toMatch(/ 1 pass/);
  expect(out).toMatch(/ 4 fail/);
});
