import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "@/lib/auth";
import {
	authErrorStatus,
	authRetryAfter,
	describeAuthError,
	loginFailureCause,
} from "./errorUtils";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const refused = (code: string, status: number, retry?: number) =>
	new AuthError("x", code, { retryAfterSeconds: retry ?? null, status });

describe("loginFailureCause", () => {
	it.each([
		[refused("INVALID_EMAIL_OR_PASSWORD", 401), "wrong_credentials"],
		[refused("EMAIL_NOT_VERIFIED", 403), "unverified"],
		[refused("HTTP_429", 429, 10), "rate_limited"],
		[refused("rate_limit.exceeded", 429), "rate_limited"],
		[refused("HTTP_403", 403), "blocked"],
		[refused("HTTP_500", 500), "server"],
		[refused("INTERNAL_SERVER_ERROR", 500), "server"],
		[new TypeError("Failed to fetch"), "network"],
		[new TypeError("Load failed"), "network"],
		[new Error("boom"), "server"],
	])("%s is %s", (error, cause) => {
		expect(loginFailureCause(error)).toBe(cause);
	});
});

describe("describeAuthError", () => {
	it("a password login's rate limit never talks about a code", () => {
		const e = refused("HTTP_429", 429);
		expect(describeAuthError(e, { flow: "password" })).not.toMatch(/code/i);
		expect(describeAuthError(e)).toMatch(/request a new code/);
	});

	it("wrong credentials stay generic: nothing says whether the account exists", () => {
		for (const code of ["INVALID_EMAIL_OR_PASSWORD", "INVALID_EMAIL"])
			expect(describeAuthError(refused(code, 401), { flow: "password" })).toBe(
				"The email or password is not right. Check them and try again.",
			);
	});

	it("a refusal from in front of dembrane says it never reached dembrane", () => {
		expect(
			describeAuthError(refused("HTTP_403", 403), { flow: "password" }),
		).toMatch(/stopped before it reached dembrane/);
	});

	it("reads the status and the wait from the error", () => {
		const e = refused("HTTP_429", 429, 12);
		expect(authErrorStatus(e)).toBe(429);
		expect(authRetryAfter(e)).toBe(12);
		expect(
			authErrorStatus({ errors: [{ extensions: { code: "HTTP_502" } }] }),
		).toBe(502);
		expect(authRetryAfter(refused("HTTP_429", 429))).toBeNull();
	});
});
