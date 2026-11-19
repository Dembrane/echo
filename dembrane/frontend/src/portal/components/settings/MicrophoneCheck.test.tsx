// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import Cookies from "js-cookie";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MicrophoneCheck } from "./MicrophoneCheck";

// what the fake analyser hears: each sample's distance from silence (128)
let amplitude = 0;
const tracks: { stop: ReturnType<typeof vi.fn> }[] = [];
const closedContexts: unknown[] = [];
const getUserMedia = vi.fn();

class FakeAudioContext {
	createMediaStreamSource() {
		return { connect: () => {} };
	}
	createAnalyser() {
		return {
			fftSize: 0,
			frequencyBinCount: 32,
			getByteTimeDomainData: (buffer: Uint8Array) => {
				buffer.fill(128 + amplitude);
			},
			smoothingTimeConstant: 0,
		};
	}
	close() {
		closedContexts.push(this);
		return Promise.resolve();
	}
}

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
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
	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		};
	}
});

beforeEach(() => {
	amplitude = 0;
	tracks.length = 0;
	closedContexts.length = 0;
	Cookies.remove("micDeviceId");
	getUserMedia.mockImplementation(async () => {
		const track = { stop: vi.fn() };
		tracks.push(track);
		return { getTracks: () => [track] };
	});
	vi.stubGlobal("navigator", {
		...navigator,
		mediaDevices: {
			enumerateDevices: async () => [
				{ deviceId: "mic-1", kind: "audioinput", label: "Desk mic" },
				{ deviceId: "cam-1", kind: "videoinput", label: "Camera" },
			],
			getUserMedia,
		},
	});
	vi.stubGlobal("AudioContext", FakeAudioContext);
	vi.stubGlobal("requestAnimationFrame", (cb: () => void) =>
		setTimeout(cb, 16),
	);
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	getUserMedia.mockReset();
});

const ui = (onMicTestSuccess: (ok: boolean) => void) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider>
			<MemoryRouter initialEntries={["/en-US/p1/start"]}>
				<MicrophoneCheck
					onContinue={() => {}}
					onMicTestSuccess={onMicTestSuccess}
				/>
			</MemoryRouter>
		</MantineProvider>
	</I18nProvider>
);

const isShown = (id: string) =>
	screen.getByTestId(id).getAttribute("aria-hidden") === "false";

it("lists only the microphones and selects the first", async () => {
	render(ui(() => {}));
	await waitFor(() =>
		expect(screen.getByTestId("portal-settings-mic-select")).toHaveProperty(
			"value",
			"Desk mic",
		),
	);
	expect(Cookies.get("micDeviceId")).toBe("mic-1");
});

it("passes the test once it hears the participant", async () => {
	const onMicTestSuccess = vi.fn();
	render(ui(onMicTestSuccess));
	await waitFor(() =>
		expect(isShown("portal-settings-mic-issue-alert")).toBe(true),
	);
	expect(onMicTestSuccess).not.toHaveBeenCalledWith(true);

	amplitude = 20;
	await waitFor(() =>
		expect(isShown("portal-settings-mic-success-alert")).toBe(true),
	);
	expect(onMicTestSuccess).toHaveBeenLastCalledWith(true);
});

it("tells the participant to allow the mic when access is blocked", async () => {
	const onMicAccessDenied = vi.fn();
	getUserMedia.mockRejectedValue(new Error("NotAllowedError"));
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter>
					<MicrophoneCheck
						onContinue={() => {}}
						onMicAccessDenied={onMicAccessDenied}
						onMicTestSuccess={() => {}}
					/>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
	expect(
		await screen.findByTestId("portal-settings-mic-error-alert"),
	).toBeTruthy();
	expect(onMicAccessDenied).toHaveBeenCalledWith(true);
});

it("keeps the mic open when the parent passes a new callback", async () => {
	const view = render(ui(() => {}));
	await waitFor(() =>
		expect(isShown("portal-settings-mic-issue-alert")).toBe(true),
	);
	const opened = getUserMedia.mock.calls.length;

	const latest = vi.fn();
	view.rerender(ui(latest));
	amplitude = 20;
	await waitFor(() => expect(latest).toHaveBeenCalledWith(true));
	expect(getUserMedia.mock.calls.length).toBe(opened);
});

it("releases the mic when it goes away", async () => {
	const view = render(ui(() => {}));
	await waitFor(() =>
		expect(isShown("portal-settings-mic-issue-alert")).toBe(true),
	);
	view.unmount();
	expect(tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
	expect(closedContexts).toHaveLength(1);
});
