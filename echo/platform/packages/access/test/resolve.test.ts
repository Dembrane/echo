import { beforeEach, describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "@echo/core";
import {
  Access,
  MemoryAccessStore,
  type Principal,
  resolveProject,
  resolveWorkspace,
} from "../src";

const now = new Date("2026-09-27T12:00:00Z");
const ada = { appUserId: "u-ada", directusUserId: "d-ada" } satisfies Principal;

let store: MemoryAccessStore;
function ws(id: string, over: Partial<Parameters<MemoryAccessStore["workspaces"]["set"]>[1]> = {}) {
  store.workspaces.set(id, {
    id,
    orgId: "org",
    visibility: "open_to_organisation",
    deleted: false,
    stickyRemoved: [],
    inheritOrgMembers: false,
    tier: "innovator",
    ...over,
  });
}
function member(workspaceId: string, role: string, over: Record<string, unknown> = {}) {
  store.memberships.push({
    workspaceId,
    appUserId: ada.appUserId,
    role,
    customPolicies: null,
    source: "direct",
    ...over,
  });
}
function project(id: string, workspaceId: string | null, over: Record<string, unknown> = {}) {
  store.projects.set(id, {
    id,
    workspaceId,
    visibility: "workspace",
    deleted: false,
    legacyOwnerDirectusUserId: null,
    ...over,
  });
}

beforeEach(() => {
  store = new MemoryAccessStore();
});

describe("workspace role", () => {
  test("a direct membership wins even when the org would derive a higher role", async () => {
    ws("w");
    member("w", "observer");
    store.orgRoles.set("org:u-ada", "owner");
    expect((await resolveWorkspace(store, "w", ada, now))?.role).toBe("observer");
  });

  test("expired and deleted memberships are ignored", async () => {
    ws("w", { visibility: "private" });
    member("w", "admin", { expiresAt: new Date("2026-09-01") });
    member("w", "member", { deleted: true });
    expect(await resolveWorkspace(store, "w", ada, now)).toBeNull();
  });

  test("legacy role viewer reads as member", async () => {
    ws("w");
    member("w", "viewer");
    expect((await resolveWorkspace(store, "w", ada, now))?.role).toBe("member");
  });

  test("org owner derives admin on every visibility", async () => {
    for (const visibility of ["open_to_organisation", "invite_only", "private"] as const) {
      store = new MemoryAccessStore();
      ws("w", { visibility });
      store.orgRoles.set("org:u-ada", "owner");
      expect((await resolveWorkspace(store, "w", ada, now))?.role).toBe("admin");
    }
  });

  test("org admin derives admin only on open workspaces", async () => {
    ws("open");
    ws("closed", { visibility: "invite_only" });
    store.orgRoles.set("org:u-ada", "admin");
    expect((await resolveWorkspace(store, "open", ada, now))?.source).toBe("inherited");
    expect(await resolveWorkspace(store, "closed", ada, now)).toBeNull();
  });

  test("org member derives member only with the legacy inherit flag; org billing never derives", async () => {
    ws("flag", { inheritOrgMembers: true });
    ws("plain");
    store.orgRoles.set("org:u-ada", "member");
    expect((await resolveWorkspace(store, "flag", ada, now))?.role).toBe("member");
    expect(await resolveWorkspace(store, "plain", ada, now)).toBeNull();
    store.orgRoles.set("org:u-ada", "billing");
    expect(await resolveWorkspace(store, "flag", ada, now)).toBeNull();
  });

  test("a sticky removal blocks derivation, owners included", async () => {
    ws("w", { stickyRemoved: ["u-ada"] });
    store.orgRoles.set("org:u-ada", "owner");
    expect(await resolveWorkspace(store, "w", ada, now)).toBeNull();
  });

  test("a deleted workspace is unreachable", async () => {
    ws("w", { deleted: true });
    member("w", "owner");
    expect(await resolveWorkspace(store, "w", ada, now)).toBeNull();
  });
});

describe("project access", () => {
  test("workspace visibility passes the workspace role through", async () => {
    ws("w");
    member("w", "external");
    project("p", "w");
    expect(await resolveProject(store, "p", ada, now)).toMatchObject({
      role: "external",
      source: "workspace",
    });
  });

  test("workspace billing users get no project data", async () => {
    ws("w");
    member("w", "billing");
    project("p", "w");
    expect(await resolveProject(store, "p", ada, now)).toBeNull();
  });

  test("private projects: admins keep access, others need a share", async () => {
    ws("w");
    project("p", "w", { visibility: "private" });
    member("w", "member");
    expect(await resolveProject(store, "p", ada, now)).toBeNull();
    store.shares.add("p:u-ada");
    expect((await resolveProject(store, "p", ada, now))?.source).toBe("project_share");
    store.memberships = [];
    store.shares.clear();
    member("w", "admin");
    expect((await resolveProject(store, "p", ada, now))?.source).toBe("workspace");
  });

  test("shares never cross workspaces", async () => {
    ws("w");
    project("p", "w", { visibility: "private" });
    store.shares.add("p:u-ada");
    expect(await resolveProject(store, "p", ada, now)).toBeNull();
  });

  test("legacy projects: only their creator, as owner, with no tier", async () => {
    project("p", null, { legacyOwnerDirectusUserId: "d-ada" });
    expect(await resolveProject(store, "p", ada, now)).toMatchObject({
      role: "owner",
      source: "legacy",
      tier: null,
    });
    expect(
      await resolveProject(store, "p", { appUserId: "u-bob", directusUserId: "d-bob" }, now),
    ).toBeNull();
  });

  test("deleted projects are unreachable", async () => {
    ws("w");
    member("w", "owner");
    project("p", "w", { deleted: true });
    expect(await resolveProject(store, "p", ada, now)).toBeNull();
  });
});

describe("authorize", () => {
  test("no access is 404, a missing policy 403, a tier gate 403 naming the tier", async () => {
    ws("w", { tier: "free" });
    project("p", "w");
    const access = new Access(store);
    await expect(access.project(ada, "p", "project:read", now)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    member("w", "member");
    await expect(access.project(ada, "p", "project:delete", now)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    store.memberships = [];
    member("w", "admin");
    const err = await access.project(ada, "p", "project:share", now).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("This action requires the innovator tier");
    expect((await access.project(ada, "p", "project:delete", now)).role).toBe("admin");
  });
});
