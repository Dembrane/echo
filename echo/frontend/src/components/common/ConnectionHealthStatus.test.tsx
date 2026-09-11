// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";
import { ConnectionHealthStatus } from "./ConnectionHealthStatus";

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

const wrap = (props: Parameters<typeof ConnectionHealthStatus>[0]) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<ConnectionHealthStatus {...props} />
			</MantineProvider>
		</I18nProvider>,
	);

it("says nothing while the connection is fine", () => {
	wrap({ isOnline: true, sseConnectionHealthy: true });

	// Not "Connection healthy" in a quieter colour: nothing at all.
	expect(screen.queryByText(/Connection/)).toBeNull();
});

it("speaks up when the stream is unhealthy", () => {
	wrap({ isOnline: true, sseConnectionHealthy: false });

	expect(screen.getByText("Connection unhealthy")).toBeTruthy();
});

it("speaks up when the device is offline", () => {
	wrap({ isOnline: false, sseConnectionHealthy: true });

	expect(screen.getByText("Connection unhealthy")).toBeTruthy();
});
