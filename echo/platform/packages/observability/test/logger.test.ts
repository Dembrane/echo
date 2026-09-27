import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger, withCorrelation } from "../src";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, stream };
}

const opts = { service: "api", release: "abc123", env: "test", level: "debug", gcpProject: "p" };

test("writes Cloud Logging shaped JSON with severity and message", () => {
  const { lines, stream } = capture();
  createLogger(opts, stream).warn({ route: "/x" }, "slow");
  expect(lines[0]).toMatchObject({ severity: "WARNING", message: "slow", service: "api", release: "abc123", route: "/x" });
});

test("stamps the request id and trace link from the current correlation", () => {
  const { lines, stream } = capture();
  const log = createLogger(opts, stream);
  withCorrelation({ requestId: "r1", traceId: "t1", spanId: "s1" }, () => log.info("hi"));
  expect(lines[0]).toMatchObject({
    request_id: "r1",
    "logging.googleapis.com/trace": "projects/p/traces/t1",
    "logging.googleapis.com/spanId": "s1",
  });
});

test("redacts credentials wherever they appear", () => {
  const { lines, stream } = capture();
  createLogger(opts, stream).info({ user: { password: "hunter2" }, token: "t" }, "login");
  expect(lines[0]?.user).toEqual({ password: "[redacted]" });
  expect(lines[0]?.token).toBe("[redacted]");
});
