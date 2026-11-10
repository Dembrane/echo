// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LoginBlockedNotice } from "./LoginBlockedNotice";
import { formatWait, LoginRateLimitNotice } from "./LoginRateLimitNotice";
import { SignedInRecoveryNotice } from "./SignedInRecoveryNotice";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
});

afterEach(cleanup);

const show = (ui: ReactNode) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>{ui}</MantineProvider>
		</I18nProvider>,
	);

describe("LoginRateLimitNotice", () => {
	it("formats the wait as a clock", () => {
		expect(formatWait(75)).toBe("1:15");
		expect(formatWait(9)).toBe("0:09");
		expect(formatWait(0)).toBe("0:00");
		expect(formatWait(-3)).toBe("0:00");
	});

	it("counts down for a password login without mentioning a code", () => {
		show(<LoginRateLimitNotice seconds={42} />);
		const notice = screen.getByTestId("auth-login-rate-limit");
		expect(notice.textContent).toContain("Too many login attempts");
		expect(notice.textContent).not.toMatch(/code/i);
		expect(screen.getByTestId("auth-login-rate-limit-wait").textContent).toBe(
			"You can try again in 0:42.",
		);
	});

	it("keeps the code wording for the code sign-in", () => {
		show(<LoginRateLimitNotice seconds={5} flow="code" />);
		expect(screen.getByTestId("auth-login-rate-limit").textContent).toContain(
			"request a new code",
		);
	});

	it("says when the wait is over", () => {
		show(<LoginRateLimitNotice seconds={0} />);
		expect(screen.getByTestId("auth-login-rate-limit-wait").textContent).toBe(
			"You can try again now.",
		);
	});
});

describe("LoginBlockedNotice", () => {
	it("offers the emailed code and names support", () => {
		const onUseCode = vi.fn();
		show(<LoginBlockedNotice onUseCode={onUseCode} />);
		const notice = screen.getByTestId("auth-login-blocked");
		expect(notice.textContent).toContain("stopped before it reached dembrane");
		expect(notice.textContent).toContain("another network or another browser");
		expect(
			screen.getByRole("link", { name: "support@dembrane.com" }),
		).toHaveProperty("href", "mailto:support@dembrane.com");
		fireEvent.click(screen.getByTestId("auth-login-blocked-use-code"));
		expect(onUseCode).toHaveBeenCalledOnce();
	});

	it("leaves the code button out when there is no code route", () => {
		show(<LoginBlockedNotice />);
		expect(screen.queryByTestId("auth-login-blocked-use-code")).toBeNull();
	});
});

describe("SignedInRecoveryNotice", () => {
	it("says the person is logged in and lets them carry on", () => {
		const onContinue = vi.fn();
		show(<SignedInRecoveryNotice onContinue={onContinue} />);
		expect(
			screen.getByTestId("auth-login-signed-in-retry").textContent,
		).toContain("You are logged in");
		fireEvent.click(screen.getByTestId("auth-login-signed-in-continue"));
		expect(onContinue).toHaveBeenCalledOnce();
	});
});
