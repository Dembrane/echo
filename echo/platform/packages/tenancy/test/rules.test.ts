import { expect, test } from "bun:test";
import { orgInviteEmail, tierDowngradedEmail, workspaceInviteEmail } from "../src/emails";
import { inviteAcceptUrl, inviteHash } from "../src/links";
import { seatState } from "../src/members";
import { pyInt, pyRound } from "../src/numbers";
import { downgradeEffects, nextTier, tierPricing } from "../src/tiers";
import { monthBounds, pyIso } from "../src/usage";

test("rounding is Python's: exact decimal value, ties to even", () => {
  expect(pyRound(0.25, 1)).toBe(0.2);
  expect(pyRound(2.675, 2)).toBe(2.67);
  expect(pyRound(-0.125, 2)).toBe(-0.12);
  expect(pyRound(0.35, 1)).toBe(0.3);
  expect(pyRound(1234.5)).toBe(1234);
  expect(pyRound(312 / 3600, 2)).toBe(0.09);
  expect(pyInt(312.9)).toBe(312);
});

test("monthly pricing rounds 172.5 to 172, as the old API showed it", () => {
  expect(tierPricing("guardian")?.monthly_billing.per_month_eur).toBe(172);
  expect(tierPricing("free")).toBeNull();
  expect(nextTier("changemaker")).toBe("guardian");
  expect(nextTier("guardian")).toBeNull();
});

test("invite links carry the old hash and query encoding", () => {
  // Expected values computed with the old API's hmac and urllib.urlencode.
  expect(inviteHash("8a000000-0000-4000-8000-000000000001", "s3cret-value")).toBe(
    "2ea5813a451ff5c081d6456ae12429ec",
  );
  expect(
    inviteAcceptUrl({
      type: "org",
      dashboardUrl: "http://localhost:5173",
      hash: "abc",
      inviterName: "Ann O'Neil (lead)*~!",
      subjectName: "Org A & B",
      role: "admin",
      email: "a+b@x.org",
    }),
  ).toBe(
    "http://localhost:5173/invite/accept?iss=Ann+O%27Neil+%28lead%29%2A~%21&role=admin&email=a%2Bb%40x.org&h=abc&org=Org+A+%26+B",
  );
});

test("a downgrade lists what it freezes and reverts, without the dead api_access", () => {
  expect(downgradeEffects("changemaker", "innovator").map((e) => e.policy)).toEqual([
    "workspace:whitelabel",
    "workspace:webhooks",
  ]);
  expect(downgradeEffects("changemaker", "free").map((e) => e.policy)).toEqual([
    "workspace:export",
    "project:share",
    "workspace:whitelabel",
    "workspace:webhooks",
    "workspace:set_private",
    "project:set_private",
  ]);
  expect(downgradeEffects("innovator", "guardian")).toEqual([]);
  // A legacy target tier meets no gate, so every feature the old tier had is listed.
  expect(downgradeEffects("innovator", "pilot").length).toBe(4);
});

test("only direct rows hold seats; observers are free and outside the pool", () => {
  expect(
    seatState([
      { user_id: "a", role: "owner", source: "direct", created_at: null },
      { user_id: "b", role: "external", source: "direct", created_at: null },
      { user_id: "c", role: "observer", source: "direct", created_at: null },
      { user_id: "d", role: "admin", source: "inherited", created_at: null },
    ]),
  ).toEqual([2, 1, 1, 1]);
});

test("calendar months are UTC and printed the way Python's isoformat prints them", () => {
  const [start, end] = monthBounds(new Date("2026-01-15T10:00:00Z"), 1);
  expect(pyIso(start)).toBe("2025-12-01T00:00:00+00:00");
  expect(pyIso(end)).toBe("2026-01-01T00:00:00+00:00");
});

test("email text parts equal the old Jinja .txt renders", () => {
  expect(
    orgInviteEmail({ inviterName: "Ann", orgName: "Org A", role: "admin", inviteUrl: "http://u" })
      .text,
  ).toBe(
    "Ann invited you to join Org A on dembrane as admin. The invite expires in 7 days.\n\nAccept the invitation:\nhttp://u\n\nOnce you accept, you can discover and request access to the workspaces your team is using.\n\nDidn't expect this? Ignore this email. Nothing will happen.\n\nThe dembrane team",
  );
  const base = {
    workspaceName: "W",
    fromTier: "changemaker",
    downgradedAtHuman: "07 September 2026",
    workspaceUrl: "http://w",
  };
  expect(
    tierDowngradedEmail({ ...base, toTier: "free", freezeItems: ["a", "b"], revertItems: ["c"] })
      .text,
  ).toBe(
    "W moved from changemaker to free on 07 September 2026.\n\nFrozen. Existing state stays, with no new use until upgrade:\n- a\n- b\n\n\nReverted:\n- c\n\n\nEverything else keeps working as it did.\n\nOpen the workspace:\nhttp://w\n\nThe dembrane team",
  );
  expect(
    tierDowngradedEmail({ ...base, toTier: "innovator", freezeItems: [], revertItems: ["c"] }).text,
  ).toBe(
    "W moved from changemaker to innovator on 07 September 2026.\n\n\nReverted:\n- c\n\n\nEverything else keeps working as it did.\n\nOpen the workspace:\nhttp://w\n\nThe dembrane team",
  );
  const invite = workspaceInviteEmail({
    subject: "s",
    inviterName: "Q <BV>",
    workspaceName: "Client X",
    inviteUrl: "http://u",
  });
  expect(invite.html).toContain("Q &lt;BV&gt; invited you to join");
  expect(invite.text).toStartWith("Q <BV> invited you to join Client X on dembrane.");
});
