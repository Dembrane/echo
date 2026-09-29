import { expect, test } from "bun:test";
import { retryWrite } from "../src/pipeline/steps";

const noSleep = async () => {};

test("a write that fails twice is retried until it lands", async () => {
  let calls = 0;
  const waits: number[] = [];
  const failure = await retryWrite(
    async () => {
      calls++;
      if (calls < 3) throw new Error("connection reset");
    },
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  expect(failure).toBeNull();
  expect(calls).toBe(3);
  expect(waits).toEqual([2000, 4000]);
});

test("a write that keeps failing gives up after five attempts and returns the last error", async () => {
  let calls = 0;
  const failure = await retryWrite(
    async () => {
      calls++;
      throw new Error("database down");
    },
    { sleep: noSleep },
  );
  expect((failure as Error).message).toBe("database down");
  expect(calls).toBe(5);
});
