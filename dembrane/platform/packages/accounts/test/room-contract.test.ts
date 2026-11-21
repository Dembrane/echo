import { describe, expect, test } from "bun:test";
import * as C from "../src/contract";
import * as F from "../src/fixtures";

// The data room in the accounts contract: its routes and who each admits, the labels and
// hints as decided, and the fixtures the dashboard is built against. No database.

const CUSTOMER = "/api/v2/orgs/:orgId/account";

describe("the data room in the contract", () => {
  test("its routes, each with the access it admits", () => {
    const R = C.ROUTES as Record<
      string,
      { method: string; path: string; permission: string; room?: true; signer?: true }
    >;
    const room = (name: string) => {
      const spec = R[name];
      expect([name, spec === undefined]).toEqual([name, false]);
      return { method: spec?.method, path: spec?.path, permission: spec?.permission };
    };
    expect(room("roomPage")).toEqual({
      method: "GET",
      path: `${CUSTOMER}/room`,
      permission: "account:room",
    });
    expect(room("addRoomPerson")).toEqual({
      method: "POST",
      path: `${CUSTOMER}/room/people`,
      permission: "account:room",
    });
    expect(room("removeRoomPerson")).toEqual({
      method: "POST",
      path: `${CUSTOMER}/room/people/:personId/remove`,
      permission: "account:room",
    });
    expect(room("answerRoomLabels")).toEqual({
      method: "POST",
      path: `${CUSTOMER}/room/me/labels`,
      permission: "account:room",
    });
    // Waving a hint away is for those who run the account: owners, admins, Billing.
    expect(room("dismissRoomHint")).toEqual({
      method: "POST",
      path: `${CUSTOMER}/room/hints/:label/dismiss`,
      permission: "account:read",
    });
    expect(room("roomInvite")).toEqual({
      method: "GET",
      path: `${CUSTOMER}/room/invite`,
      permission: "invite-link",
    });
    expect(room("acceptRoomInvite")).toEqual({
      method: "POST",
      path: `${CUSTOMER}/room/invite/accept`,
      permission: "signed-in",
    });
    expect(room("staffRoomPage")).toEqual({
      method: "GET",
      path: "/api/v2/admin/accounts/:orgId/room",
      permission: "staff:accounts",
    });
    // The routes a member with room access also reaches, and only these.
    const admitted = Object.entries(R)
      .filter(([, s]) => s.room)
      .map(([n]) => n)
      .sort();
    expect(admitted).toEqual(
      [
        "accountPage",
        "documentFile",
        "legalText",
        "readDocument",
        "signedPdf",
        "viewDocument",
      ].sort(),
    );
    for (const name of [
      "readBilling",
      "updateBilling",
      "signDocument",
      "declineDocument",
      "nameSigner",
      "submitTask",
      "openTicket",
    ])
      expect([name, R[name]?.room]).toEqual([name, undefined]);
  });

  test("six labels and Other, no 'will use it', and hints for four of them", () => {
    expect(C.RoomLabel.options).toEqual([
      "go_ahead",
      "rollout",
      "it_security",
      "privacy_ai",
      "contract_purchasing",
      "staff_stakeholders",
    ]);
    expect(C.HintLabel.options).toEqual([
      "go_ahead",
      "it_security",
      "privacy_ai",
      "contract_purchasing",
    ]);
    const base = { email: "a@example.test", name: "A" };
    expect(C.AddRoomPersonRequest.safeParse({ ...base, labels: ["uses"] }).success).toBe(false);
    expect(
      C.AddRoomPersonRequest.safeParse({ ...base, labels: ["rollout", "rollout"] }).success,
    ).toBe(false);
    // No labels and no Other: kept informed.
    expect(C.AddRoomPersonRequest.parse({ ...base, labels: [] })).toEqual({
      ...base,
      labels: [],
      other: null,
    });
    expect(C.AddRoomPersonRequest.parse({ ...base, labels: [], other: "  " }).other).toBeNull();
  });

  test("the fixtures the dashboard is built against parse", () => {
    const cases: [string, { parse: (v: unknown) => unknown } | undefined, unknown][] = [
      ["roomPage", C.RoomPage, F.roomPage],
      ["roomPageAsColleague", C.RoomPage, F.roomPageAsColleague],
      ["addRoomPersonResponse", C.AddRoomPersonResponse, F.addRoomPersonResponse],
      ["roomInvite", C.RoomInvite, F.roomInvite],
    ];
    for (const [name, schema, value] of cases) {
      expect([name, schema !== undefined, value !== undefined]).toEqual([name, true, true]);
      expect(() => schema?.parse(value)).not.toThrow();
    }
    // The colleague's page: someone invited, asked about their labels, who waves no hints.
    const colleague = C.RoomPage.parse(F.roomPageAsColleague);
    expect(colleague.me?.room).toBe("by_invite");
    expect(colleague.me?.may_dismiss_hints).toBe(false);
  });
});
