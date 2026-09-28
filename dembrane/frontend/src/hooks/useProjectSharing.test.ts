// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInvitePayload } from "@/components/invite/api";
import { ApiError } from "@/components/invite/api";
import { shareWithEmails, summarizeInviteResults } from "./useProjectSharing";

describe("shareWithEmails", () => {
	it("splits emails into shared, needs-invite and failed", async () => {
		const calls: string[] = [];
		const add = vi.fn(async (vars: { email: string }) => {
			calls.push(vars.email);
			if (vars.email === "new@example.com") {
				throw new ApiError("not on workspace", 404, "not_a_member");
			}
			if (vars.email === "broken@example.com") {
				throw new ApiError("Boom", 500);
			}
		});

		const result = await shareWithEmails(
			["member@example.com", "new@example.com", "broken@example.com"],
			add,
		);

		expect(calls).toEqual([
			"member@example.com",
			"new@example.com",
			"broken@example.com",
		]);
		expect(add).toHaveBeenCalledWith({ email: "member@example.com" });
		expect(result.shared).toEqual(["member@example.com"]);
		expect(result.needsInvite).toEqual(["new@example.com"]);
		expect(result.failed).toEqual([
			{ email: "broken@example.com", message: "Boom" },
		]);
	});

	it("keeps going after a failure so every email is attempted once", async () => {
		const add = vi.fn(async () => {
			throw new Error("network");
		});
		const result = await shareWithEmails(["a@x.com", "b@x.com"], add);
		expect(add).toHaveBeenCalledTimes(2);
		expect(result.failed.map((f) => f.email)).toEqual(["a@x.com", "b@x.com"]);
		expect(result.shared).toEqual([]);
		expect(result.needsInvite).toEqual([]);
	});
});

describe("summarizeInviteResults", () => {
	const ok = (email: string, payload: Partial<WorkspaceInvitePayload>) => ({
		email,
		outcome: {
			status: "fulfilled" as const,
			value: { status: "invited", email, email_sent: true, ...payload },
		},
	});

	it("keeps the modal open when the only email is pending for another project", () => {
		const s = summarizeInviteResults([
			ok("a@x.com", {
				status: "already_invited",
				email_sent: false,
				project_share: "pending_other_project",
			}),
		]);
		expect(s.otherProject).toEqual(["a@x.com"]);
		expect(s.allClean).toBe(false);
		expect(s.sent).toBe(0);
		expect(s.alreadyPending).toBe(0);
	});

	it("counts a clean mixed batch and allows closing", () => {
		const s = summarizeInviteResults([
			ok("granted@x.com", { status: "added", project_share: "granted" }),
			ok("fresh@x.com", {
				status: "invited",
				email_sent: true,
				project_share: "pending",
			}),
			ok("waiting@x.com", {
				status: "already_invited",
				email_sent: false,
				project_share: "pending",
			}),
		]);
		expect(s.granted).toBe(1);
		expect(s.sent).toBe(1);
		expect(s.alreadyPending).toBe(1);
		expect(s.allClean).toBe(true);
	});

	it("reports an invite whose email could not be sent", () => {
		const s = summarizeInviteResults([
			ok("a@x.com", { status: "invited", email_sent: false }),
		]);
		expect(s.emailNotSent).toEqual(["a@x.com"]);
		expect(s.sent).toBe(0);
		expect(s.allClean).toBe(false);
	});

	it("collects rejected invites", () => {
		const err = new ApiError("Access denied", 403);
		const s = summarizeInviteResults([
			{ email: "a@x.com", outcome: { status: "rejected", reason: err } },
			ok("b@x.com", { status: "invited", email_sent: true }),
		]);
		expect(s.failed).toEqual([{ email: "a@x.com", reason: err }]);
		expect(s.sent).toBe(1);
		expect(s.allClean).toBe(false);
	});
});
