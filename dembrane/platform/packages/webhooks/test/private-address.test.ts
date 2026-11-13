import { describe, expect, test } from "bun:test";
import { isPrivateAddress } from "../src";

// isPrivateAddress reads host-supplied text (webhook targets, and the setup suggestions'
// page fetch), so it parses without regular expressions and refuses anything that is not
// an IP literal before parsing it.
describe("isPrivateAddress", () => {
  test("private, reserved and IPv4-carrying addresses are blocked", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "198.18.0.1",
      "192.0.0.1",
      "224.0.0.1",
      "::",
      "::1",
      "fd00::1",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::ffff:0:7f00:1",
      "::7f00:1",
      "::10.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::10.0.0.1",
      "64:ff9b:1::8.8.8.8",
      "2002:a00:1::1",
      "2002:7f00:1::",
      "fe80::1%eth0",
      "fe80::1%25eth0",
      "FE80::1",
    ])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
  });

  test("public addresses pass, also with a zone id or an embedded public IPv4", () => {
    for (const ip of [
      "8.8.8.8",
      "172.32.0.1",
      "2a00:1450::1",
      "2A00:1450::1",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "64:ff9b::8.8.8.8",
      "2002:808:808::1",
      "2a00:1450::1%eth0",
    ])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  });

  test("anything that is not an IP literal is blocked", () => {
    for (const ip of [
      "",
      "not-an-ip",
      "example.com",
      "fe80::1%",
      "1::2::3",
      "::ffff:1.2.3.04",
      "1.2.3",
      "12345::1",
      "g::1",
      `2a00:1450::1%${"x".repeat(200)}`,
    ])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
  });

  test("long hostile input returns at once", () => {
    for (const ip of [
      "%".repeat(50_000),
      "0".repeat(50_000),
      `::${"0".repeat(50_000)}`,
      `${"0.".repeat(25_000)}0`,
      `fe80::1${"%".repeat(50_000)}`,
    ]) {
      const start = performance.now();
      expect(isPrivateAddress(ip)).toBe(true);
      expect(performance.now() - start).toBeLessThan(250);
    }
  });
});
