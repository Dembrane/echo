import { expect, test } from "bun:test";
import { hashMatches, inviteAcceptUrl, inviteHash, urlencode } from "../src/invites/hash";
import { isOutsider, rank } from "../src/invites/membership";
import { flagReview } from "../src/onboarding";
import { passwordProblems } from "../src/password";
import { fileTitle } from "../src/settings";

test("invite hash is the first 32 hex chars of HMAC-SHA256 and compares in constant time", () => {
  // Same value Python's hmac.new(secret, id, sha256).hexdigest()[:32] gives.
  const h = inviteHash("secret", "aa000000-0000-4000-8000-000000000001");
  expect(h).toMatch(/^[0-9a-f]{32}$/);
  expect(hashMatches("secret", "aa000000-0000-4000-8000-000000000001", h)).toBe(true);
  expect(hashMatches("secret", "aa000000-0000-4000-8000-000000000001", "short")).toBe(false);
});

test("urlencode follows Python's quote_plus", () => {
  expect(urlencode({ a: "x y", b: "a+b@c.d~!*" })).toBe("a=x+y&b=a%2Bb%40c.d~%21%2A");
  expect(
    inviteAcceptUrl({
      type: "workspace",
      dashboardUrl: "https://d",
      hash: "h",
      inviterName: "Ann",
      subjectName: "Team A",
      role: "member",
      email: "a@b.co",
    }),
  ).toBe("https://d/invite/accept?iss=Ann&role=member&email=a%40b.co&h=h&ws=Team+A");
});

test("outsiders are external and observer; unknown roles rank 0 unless told otherwise", () => {
  expect(isOutsider("observer")).toBe(true);
  expect(isOutsider("member")).toBe(false);
  expect(rank("owner")).toBe(5);
  expect(rank("nonsense")).toBe(0);
  expect(rank("nonsense", -1)).toBe(-1);
});

test("onboarding follow-up flags come from q1, q2 and the last q3", () => {
  expect(
    flagReview([
      { q1: ["Internal", "With clients"] },
      { q2: " Yes " },
      { q3: "Yes" },
      { q3: "No" },
    ]),
  ).toEqual({
    partner: true,
    highRisk: true,
    training: "no",
  });
  expect(flagReview([1, { q2: false }])).toEqual({
    partner: false,
    highRisk: false,
    training: null,
  });
});

test("password policy lists every unmet rule", () => {
  expect(passwordProblems("abc")).toEqual([
    "Password must be at least 8 characters",
    "Password must contain an uppercase letter",
    "Password must contain a number",
    "Password must contain a symbol",
  ]);
  expect(passwordProblems("Str0ng!pass")).toEqual([]);
});

test("upload titles read like Directus's", () => {
  expect(fileTitle("my_avatar-2.png")).toBe("My Avatar 2");
});
