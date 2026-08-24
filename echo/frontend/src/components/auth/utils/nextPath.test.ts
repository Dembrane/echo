import { describe, expect, it } from "vitest";
import { resolveNextPath } from "./nextPath";

const ORG_A = "3dab35ac-47ff-47c6-b48f-0e366b0f8555";
const ORG_B = "9c1f2e10-1111-4222-8333-444455556666";
const WS_A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const WS_B = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";

const workspaces = [
	{ id: WS_A, org_id: ORG_A },
	{ id: WS_B, org_id: ORG_A },
];

describe("resolveNextPath", () => {
	it("rejects unsafe paths", () => {
		expect(resolveNextPath("https://evil.com", workspaces)).toBeNull();
		expect(resolveNextPath("//evil.com", workspaces)).toBeNull();
		expect(resolveNextPath("/\\evil.com", workspaces)).toBeNull();
		expect(resolveNextPath("relative/path", workspaces)).toBeNull();
		expect(resolveNextPath(null, workspaces)).toBeNull();
		expect(resolveNextPath(undefined, workspaces)).toBeNull();
		expect(resolveNextPath("", workspaces)).toBeNull();
	});

	it("rejects auth paths to avoid redirect loops", () => {
		expect(resolveNextPath("/login", workspaces)).toBeNull();
		expect(resolveNextPath("/en-US/login?verified=1", workspaces)).toBeNull();
		expect(resolveNextPath("/register", workspaces)).toBeNull();
	});

	it("allows an org path the user has a workspace in", () => {
		expect(resolveNextPath(`/o/${ORG_A}/overview`, workspaces)).toBe(
			`/o/${ORG_A}/overview`,
		);
	});

	it("allows a locale-prefixed org path the user has access to", () => {
		expect(resolveNextPath(`/en-US/o/${ORG_A}/overview`, workspaces)).toBe(
			`/en-US/o/${ORG_A}/overview`,
		);
	});

	it("rejects an org path the user has no access to", () => {
		expect(resolveNextPath(`/o/${ORG_B}/overview`, workspaces)).toBeNull();
		expect(
			resolveNextPath(`/en-US/o/${ORG_B}/overview`, workspaces),
		).toBeNull();
	});

	it("allows the bare /o landing without any access check", () => {
		expect(resolveNextPath("/o", workspaces)).toBe("/o");
		expect(resolveNextPath("/en-US/o", workspaces)).toBe("/en-US/o");
	});

	it("allows a workspace path the user is a member of", () => {
		expect(resolveNextPath(`/w/${WS_A}/home`, workspaces)).toBe(
			`/w/${WS_A}/home`,
		);
	});

	it("rejects a workspace path the user is not a member of", () => {
		const foreignWs = "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f";
		expect(resolveNextPath(`/w/${foreignWs}/home`, workspaces)).toBeNull();
	});

	it("allows unscoped app paths", () => {
		expect(resolveNextPath("/profile", workspaces)).toBe("/profile");
	});

	it("ignores query and hash when extracting scope ids", () => {
		expect(
			resolveNextPath(`/o/${ORG_B}/overview?tab=members`, workspaces),
		).toBeNull();
		expect(
			resolveNextPath(`/o/${ORG_A}/overview?tab=members#x`, workspaces),
		).toBe(`/o/${ORG_A}/overview?tab=members#x`);
	});

	it("rejects org/workspace paths when the workspace list is empty", () => {
		expect(resolveNextPath(`/o/${ORG_A}/overview`, [])).toBeNull();
		expect(resolveNextPath(`/w/${WS_A}/home`, [])).toBeNull();
	});
});
