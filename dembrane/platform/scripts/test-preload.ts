import { afterEach } from "bun:test";
import {
  resetObserverFaults,
  takeObserverFaults,
  takeUnscopedFakeCalls,
} from "../packages/llm/src";

// Every test proves its AI calls ran under a payer and its model observer never faulted.
afterEach(() => {
  const unscoped = takeUnscopedFakeCalls();
  const faults = takeObserverFaults();
  resetObserverFaults();
  if (unscoped.length > 0) {
    const calls = unscoped.map((c) => `${c.kind} ${c.model}`).join(", ");
    throw new Error(
      `AI call without a payer scope in this test: ${calls}. Wrap the entry point in withPayer, or scope the test.`,
    );
  }
  if (faults.length > 0) {
    throw new Error(`The model observer faulted in this test: ${String(faults[0])}`);
  }
});
