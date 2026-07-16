// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { ParticipantState } from "@/hooks/useConversationMonitor";
import { StatePill } from "./LiveMonitorSection";

// MantineProvider reads the OS color scheme on mount; jsdom has no
// matchMedia, so stub a minimal (always non-matching) implementation.
beforeAll(() => {
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

const renderPill = (state: ParticipantState) =>
	render(
		<MantineProvider>
			<StatePill state={state} />
		</MantineProvider>,
	);

describe("StatePill", () => {
	it("renders Recording for the recording state", () => {
		const { getByText } = renderPill("recording");
		expect(getByText("Recording")).toBeTruthy();
	});

	it("renders Offline for the offline state", () => {
		const { getByText } = renderPill("offline");
		expect(getByText("Offline")).toBeTruthy();
	});

	it("renders Away for the backgrounded state", () => {
		const { getByText } = renderPill("backgrounded");
		expect(getByText("Away")).toBeTruthy();
	});

	it("renders Left for the left state", () => {
		const { getByText } = renderPill("left");
		expect(getByText("Left")).toBeTruthy();
	});

	it("renders Idle for an unknown/idle state", () => {
		const { getByText } = renderPill("idle");
		expect(getByText("Idle")).toBeTruthy();
	});
});
