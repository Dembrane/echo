// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { BOOKING_REFERENCE_METADATA_KEY } from "@/components/pricing/bookingPrefill";
import { BookingLinks } from "@/lib/links";

// "Book a call" on the account page: the cal.com step with the person's name and mail
// prefilled, and a booking recorded on the account. The `Cal` global is a mock, as in
// PricingBookingStep.test.tsx.
const me = vi.hoisted(() => ({
	data: { display_name: "Pieter", email: "pieter@example.org" } as
		| { display_name: string; email: string }
		| undefined,
}));
const call = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => me }));
vi.mock("../api/client", () => ({ call }));

import BookCall from "./BookCall";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia = ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		matches: false,
		media: query,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
});

afterEach(() => {
	cleanup();
	call.mockClear();
	(globalThis as { Cal?: unknown }).Cal = undefined;
	for (const script of document.querySelectorAll(
		`script[src="${BookingLinks.EMBED_SCRIPT}"]`,
	)) {
		script.remove();
	}
});

const mockCal = () => {
	const inline = vi.fn();
	(globalThis as { Cal?: unknown }).Cal = Object.assign(vi.fn(), {
		ns: { [BookingLinks.EMBED_NAMESPACE]: inline },
	});
	const script = document.createElement("script");
	script.src = BookingLinks.EMBED_SCRIPT;
	document.head.appendChild(script);
	return inline;
};

const client = new QueryClient();
const ui = () => (
	<QueryClientProvider client={client}>
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<BookCall orgId="org-1" reference="ACC-7" />
			</MantineProvider>
		</I18nProvider>
	</QueryClientProvider>
);

it("prefills the reference, the name and the mail address", () => {
	const inline = mockCal();
	render(ui());
	const config = (
		inline.mock.calls[0] as [string, { config: Record<string, string> }]
	)[1].config;
	expect(config.notes).toBe("Reference ACC-7");
	expect(config[BOOKING_REFERENCE_METADATA_KEY]).toBe("ACC-7");
	expect(config.name).toBe("Pieter");
	expect(config.email).toBe("pieter@example.org");
});

it("sets the embed up once across re-renders", () => {
	const inline = mockCal();
	const view = render(ui());
	view.rerender(ui());
	view.rerender(ui());
	expect(inline).toHaveBeenCalledTimes(1);
});

it("records a booking on the account", async () => {
	mockCal();
	render(ui());
	await act(async () => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					data: {
						startTime: "2026-10-12T09:00:00Z",
						status: "ACCEPTED",
						uid: "b-9",
					},
					originator: "CAL",
					type: "bookingSuccessfulV2",
				},
				origin: "https://app.cal.com",
			}),
		);
	});
	expect(call).toHaveBeenCalledWith("recordBooking", {
		body: { start: "2026-10-12T09:00:00Z", status: "ACCEPTED", uid: "b-9" },
		params: { orgId: "org-1" },
	});
});
