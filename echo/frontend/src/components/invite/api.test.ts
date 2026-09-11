// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, inviteToWorkspace, parseApiError } from "./api";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("parseApiError", () => {
	it("reads a structured detail", () => {
		const err = parseApiError(
			404,
			{
				detail: {
					code: "not_a_member",
					message: "That email isn't on this workspace.",
				},
			},
			"fallback",
		);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.code).toBe("not_a_member");
		expect(err.status).toBe(404);
		expect(err.message).toBe("That email isn't on this workspace.");
	});

	it("keeps plain string details as the message", () => {
		const err = parseApiError(
			400,
			{ detail: "Mark it private first." },
			"fallback",
		);
		expect(err.code).toBeUndefined();
		expect(err.message).toBe("Mark it private first.");
	});

	it("falls back when the body has no detail", () => {
		const err = parseApiError(500, {}, "Couldn't add person");
		expect(err.message).toBe("Couldn't add person");
		expect(err.status).toBe(500);
	});
});

describe("inviteToWorkspace", () => {
	it("posts email and role, and omits project_id when none is given", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				status: "invited",
				email: "a@x.com",
				email_sent: true,
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		await inviteToWorkspace("ws-1", "a@x.com", "member");
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toMatch(/\/v2\/workspaces\/ws-1\/invite$/);
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("include");
		expect(JSON.parse(init.body as string)).toEqual({
			email: "a@x.com",
			role: "member",
		});
	});

	it("adds project_id when sharing a project along with the invite", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				status: "invited",
				email: "new@example.com",
				email_sent: true,
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const result = await inviteToWorkspace(
			"ws-1",
			"new@example.com",
			"observer",
			{
				projectId: "proj-1",
			},
		);
		expect(result.status).toBe("invited");
		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(JSON.parse(init.body as string)).toEqual({
			email: "new@example.com",
			role: "observer",
			project_id: "proj-1",
		});
	});

	it("throws an ApiError carrying the status on failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 403,
				json: async () => ({ detail: "Access denied" }),
			})),
		);
		await expect(
			inviteToWorkspace("ws-1", "new@example.com", "member"),
		).rejects.toMatchObject({
			status: 403,
			message: "Access denied",
		});
	});
});
