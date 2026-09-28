import { expect, test } from "bun:test";
import { missingAssets } from "@dembrane/core";
import { WORKER_ASSETS } from "../src/assets";

test("every file the worker's boot check requires is in the source tree", () => {
  expect(missingAssets(WORKER_ASSETS)).toEqual([]);
});
