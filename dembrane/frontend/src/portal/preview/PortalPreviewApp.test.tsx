// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { Outlet } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { portalDefaults } from "@/components/project/portal-editor/portalForm";
import { buildPreviewMessage } from "@/components/project/portal-editor/preview/buildPreviewMessage";
import { ADMIN_BASE_URL } from "@/config";
import { originOf, PREVIEW_READY } from "@/lib/portalPreview/protocol";
import { lockDown } from "./lockDown";
import { PortalPreviewApp } from "./PortalPreviewApp";

vi.mock("posthog-js", () => ({
	default: { capture: vi.fn(), register: vi.fn() },
}));
vi.mock("../layout/ParticipantLayout", () => ({
	ParticipantLayout: () => <Outlet />,
}));
vi.mock("./PreviewScreens", async () => {
	const { createContext } = await import("react");
	const screen = (name: string) => () => <div data-testid={`screen-${name}`} />;
	return {
		ExploreScreen: screen("explore"),
		FinishScreen: screen("finish"),
		OnboardingScreen: ({ card }: { card: string }) => (
			<div data-testid={`screen-onboarding-${card}`} />
		),
		PreviewResultContext: createContext(null),
		RecordingScreen: screen("recording"),
		VerifySummaryScreen: screen("verify-summary"),
		VerifyTopicsScreen: screen("verify-topics"),
	};
});

afterEach(cleanup);

const dashboard = originOf(ADMIN_BASE_URL) ?? "";
const message = buildPreviewMessage({
	highlight: null,
	legal: null,
	screen: "finish",
	tags: [],
	topics: undefined,
	values: portalDefaults({ id: "p1", language: "en" } as Project),
});

const send = (data: unknown, origin: string, source: unknown = window) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data, origin, source: source as Window }),
		);
	});

// ECHO-1060: the portal's preview mode listens to the dashboard only.
describe("PortalPreviewApp", () => {
	it("says it is ready, to the dashboard's origin only", () => {
		const post = vi.spyOn(window.parent, "postMessage");
		render(<PortalPreviewApp projectId="p1" />);
		expect(post).toHaveBeenCalledWith({ type: PREVIEW_READY }, dashboard);
		post.mockRestore();
	});

	it("ignores another origin, another sender and a malformed message", () => {
		render(<PortalPreviewApp projectId="p1" />);
		send(message, "https://evil.example");
		send(message, dashboard, null);
		send({ ...message, screen: "admin" }, dashboard);
		send("hello", dashboard);
		expect(screen.queryByTestId("portal-preview-root")).toBeNull();
	});

	it("draws the screen a valid message names, inert", () => {
		render(<PortalPreviewApp projectId="p1" />);
		send(message, dashboard);
		const root = screen.getByTestId("portal-preview-root");
		expect(root.hasAttribute("inert")).toBe(true);
		expect(screen.getByTestId("screen-finish")).toBeTruthy();
		send({ ...message, screen: "privacy" }, dashboard);
		expect(screen.getByTestId("screen-onboarding-privacy")).toBeTruthy();
	});
});

describe("lockDown", () => {
	it("takes away requests, beacons, sockets and devices", async () => {
		const win = {
			EventSource: class {},
			fetch: vi.fn(),
			navigator: { mediaDevices: { getUserMedia: vi.fn() } },
			WebSocket: class {},
			XMLHttpRequest: class {},
		} as unknown as Window & typeof globalThis;
		lockDown(win);
		await expect(win.fetch("/api/x")).rejects.toThrow();
		expect(() => new win.XMLHttpRequest()).toThrow();
		expect(() => new win.WebSocket("wss://x")).toThrow();
		expect(() => new win.EventSource("/x")).toThrow();
		expect(win.navigator.sendBeacon("/x")).toBe(false);
		await expect(
			win.navigator.mediaDevices.getUserMedia({ audio: true }),
		).rejects.toThrow();
	});
});
