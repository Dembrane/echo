// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
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
// Each mount of a screen, to see when the preview starts one again.
const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("./PreviewScreens", async () => {
	const { createContext, useEffect } = await import("react");
	const screen = (name: string) => () => {
		useEffect(() => {
			mounts.count++;
		}, []);
		return <div data-testid={`screen-${name}`} />;
	};
	return {
		ExploreReplyContext: createContext(null),
		FinishScreen: screen("finish"),
		OnboardingScreen: ({ card }: { card: string }) => (
			<div data-testid={`screen-onboarding-${card}`} />
		),
		RecordingScreen: screen("recording"),
		RefineScreen: screen("refine"),
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

	it("draws the screen a valid message names, for the host to click through", () => {
		render(<PortalPreviewApp projectId="p1" />);
		send(message, dashboard);
		const root = screen.getByTestId("portal-preview-root");
		expect(root.hasAttribute("inert")).toBe(false);
		expect(screen.getByTestId("screen-finish")).toBeTruthy();
		send({ ...message, screen: "privacy" }, dashboard);
		expect(screen.getByTestId("screen-onboarding-privacy")).toBeTruthy();
	});

	// ECHO-1062: the host edits or opens an option, and the phone is back on its screen.
	it("starts the screen again on a new reset, once the host clicked inside", () => {
		render(<PortalPreviewApp projectId="p1" />);
		send({ ...message, reset: 1 }, dashboard);
		const first = mounts.count;
		// Typing in the editor: values change in place, the screen stays.
		send({ ...message, reset: 2 }, dashboard);
		expect(mounts.count).toBe(first);
		// The host clicked onward in the phone, then edits: the same screen starts again.
		fireEvent.pointerDown(screen.getByTestId("screen-finish"));
		send({ ...message, reset: 3 }, dashboard);
		expect(mounts.count).toBe(first + 1);
		expect(screen.getByTestId("screen-finish")).toBeTruthy();
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

	// ECHO-1062: the screens are clickable, so forms, links and storage are held in.
	it("cancels form submissions and plain links, and keeps storage in memory", () => {
		localStorage.setItem("kept", "1");
		const real = window.localStorage;
		lockDown(window);
		const form = document.createElement("form");
		document.body.append(form);
		const submit = new Event("submit", { bubbles: true, cancelable: true });
		form.dispatchEvent(submit);
		expect(submit.defaultPrevented).toBe(true);
		expect(() => form.submit()).not.toThrow();

		const link = document.createElement("a");
		link.href = "https://example.com/elsewhere";
		document.body.append(link);
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		link.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);

		expect(window.localStorage).not.toBe(real);
		expect(window.localStorage.getItem("kept")).toBe("1");
		window.localStorage.setItem("cooldown", "now");
		expect(window.localStorage.getItem("cooldown")).toBe("now");
		expect(real.getItem("cooldown")).toBeNull();
		form.remove();
		link.remove();
	});
});
