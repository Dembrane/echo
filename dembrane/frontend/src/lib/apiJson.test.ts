import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE_URL } from "@/config";
import { apiJson, postJson, requestFailure } from "./apiJson";
import { ApiRequestError } from "./errors/read";

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) =>
	vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("apiJson", () => {
	it("posts JSON with the session cookie and returns the answer", async () => {
		const fetch = answer(200, { ok: 1 });
		vi.stubGlobal("fetch", fetch);
		const signal = new AbortController().signal;
		expect(await postJson("/v2/x", { a: 1 }, signal)).toEqual({ ok: 1 });
		expect(fetch).toHaveBeenCalledWith(`${API_BASE_URL}/v2/x`, {
			body: '{"a":1}',
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
			signal,
		});
	});

	it("a GET sends no body", async () => {
		const fetch = answer(200, []);
		vi.stubGlobal("fetch", fetch);
		await apiJson("/v2/y");
		expect(fetch).toHaveBeenCalledWith(
			`${API_BASE_URL}/v2/y`,
			expect.objectContaining({ body: undefined, method: "GET" }),
		);
	});

	it("a failed answer is an ApiRequestError with its body", async () => {
		vi.stubGlobal("fetch", answer(402, { code: "free.ai_budget" }));
		const error = await postJson("/v2/x", {}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error).toMatchObject({
			body: { code: "free.ai_budget" },
			status: 402,
		});
		expect(requestFailure(error)).toBe("budget");
	});
});

describe("requestFailure", () => {
	it.each([
		[402, "budget"],
		[503, "unavailable"],
		[429, "rate_limited"],
		[400, "invalid"],
		[422, "invalid"],
		[403, "forbidden"],
		[404, "forbidden"],
		[500, "error"],
	])("%s is %s", (status, cause) => {
		expect(requestFailure(new ApiRequestError(status, {}))).toBe(cause);
	});
	it("a fetch that never reached the server is network", () => {
		expect(requestFailure(new TypeError("Failed to fetch"))).toBe("network");
	});
});
