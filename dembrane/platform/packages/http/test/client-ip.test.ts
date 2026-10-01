import { expect, test } from "bun:test";
import { CLIENT_IP_HEADER, PROXY_SECRET_HEADER, resolveClientIp } from "../src/client-ip";

const LB = "136.81.232.104";
const SECRET = "s".repeat(40);
const h = (init: Record<string, string>) => new Headers(init);

test("the rightmost entry is the caller when no proxy of ours is in the chain", () => {
  expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.7" }), null)).toBe("198.51.100.7");
  expect(resolveClientIp(h({ "x-forwarded-for": "10.0.0.1, 198.51.100.7" }), null)).toBe(
    "198.51.100.7",
  );
});

test("our load balancer is skipped, and what the caller put in front is not read", () => {
  const headers = h({ "x-forwarded-for": `203.0.113.9, 198.51.100.7, ${LB}` });
  expect(resolveClientIp(headers, null, { trustedProxies: [LB] })).toBe("198.51.100.7");
});

test("a range of proxies is skipped", () => {
  const headers = h({ "x-forwarded-for": "198.51.100.7, 10.4.0.12, 10.4.3.1" });
  expect(resolveClientIp(headers, null, { trustedProxies: ["10.4.0.0/16"] })).toBe("198.51.100.7");
});

test("IPv6 callers and proxies", () => {
  const headers = h({ "x-forwarded-for": "2001:db8::7, 2001:db8:ffff::1" });
  expect(resolveClientIp(headers, null, { trustedProxies: ["2001:db8:ffff::/48"] })).toBe(
    "2001:db8::7",
  );
  expect(
    resolveClientIp(h({ "x-forwarded-for": `198.51.100.7, ::ffff:${LB}` }), null, {
      trustedProxies: [LB],
    }),
  ).toBe("198.51.100.7");
});

test("without a chain the peer address is used, else unknown", () => {
  expect(resolveClientIp(h({}), "192.0.2.4")).toBe("192.0.2.4");
  expect(resolveClientIp(h({}), null)).toBe("unknown");
  expect(resolveClientIp(h({ "x-forwarded-for": LB }), "192.0.2.4", { trustedProxies: [LB] })).toBe(
    "192.0.2.4",
  );
});

test("the web server's address is believed only with the shared secret", () => {
  const forwarded = {
    "x-forwarded-for": "198.51.100.7, 34.1.2.3",
    [CLIENT_IP_HEADER]: "198.51.100.7",
  };
  expect(
    resolveClientIp(h({ ...forwarded, [PROXY_SECRET_HEADER]: SECRET }), null, {
      proxySecret: SECRET,
    }),
  ).toBe("198.51.100.7");
  expect(
    resolveClientIp(h({ ...forwarded, [PROXY_SECRET_HEADER]: "x".repeat(40) }), null, {
      proxySecret: SECRET,
    }),
  ).toBe("34.1.2.3");
  expect(resolveClientIp(h(forwarded), null, { proxySecret: SECRET })).toBe("34.1.2.3");
  expect(resolveClientIp(h({ ...forwarded, [PROXY_SECRET_HEADER]: SECRET }), null)).toBe(
    "34.1.2.3",
  );
});

test("an entry that is not an address or range trusts nothing", () => {
  const headers = h({ "x-forwarded-for": "198.51.100.7" });
  expect(resolveClientIp(headers, null, { trustedProxies: ["not-an-ip", "1.2.3.4/99"] })).toBe(
    "198.51.100.7",
  );
});
