import { expect, test } from "bun:test";
import { browserDetails } from "../src/device";

test("browser labels distinguish Edge from Chrome and iPhone from macOS", () => {
  expect(
    browserDetails("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0"),
  ).toEqual({ browser: "Edge", platform: "Windows" });
  expect(
    browserDetails(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1",
    ),
  ).toEqual({ browser: "Safari", platform: "iPhone" });
  expect(
    browserDetails("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) CriOS/130.0 Safari/604.1"),
  ).toEqual({ browser: "Chrome", platform: "iPad" });
  expect(browserDetails("Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Safari/537.36")).toEqual({
    browser: "Chrome",
    platform: "Android",
  });
  expect(browserDetails("Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0")).toEqual({
    browser: "Firefox",
    platform: "Linux",
  });
});

test("an unknown user agent is not echoed in a device label", () => {
  expect(browserDetails(null)).toEqual({ browser: null, platform: null });
  expect(browserDetails("arbitrary private information")).toEqual({
    browser: null,
    platform: null,
  });
});
