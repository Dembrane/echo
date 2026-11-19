// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PREVIEW_READY } from "@/lib/portalPreview/protocol";
import { portalDefaults } from "../portalForm";
import { buildPreviewMessage } from "./buildPreviewMessage";
import { PortalPreviewFrame } from "./PortalPreviewFrame";

const PORTAL = "https://portal.example";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia =
		window.matchMedia ||
		(((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		})) as unknown as typeof window.matchMedia);
});

afterEach(cleanup);

const message = buildPreviewMessage({
	highlight: null,
	legal: null,
	screen: "landing",
	tags: [],
	topics: undefined,
	values: portalDefaults({ id: "p1", language: "nl" } as unknown as Project),
});

const renderFrame = () => {
	const view = render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<PortalPreviewFrame
					projectId="p1"
					message={message}
					screens={["landing"]}
					onScreen={() => {}}
					portalUrl={`${PORTAL}/`}
				/>
			</MantineProvider>
		</I18nProvider>,
	);
	const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
	const inner = frame.contentWindow as Window;
	const post = vi.spyOn(inner, "postMessage").mockImplementation(() => {});
	const ready = (origin: string, source: MessageEventSource | null) =>
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: PREVIEW_READY },
					origin,
					source,
				}),
			);
		});
	return { frame, inner, post, ready };
};

// ECHO-1060: the dashboard talks to the portal's frame only, and listens to it only.
describe("PortalPreviewFrame", () => {
	it("loads the portal's preview address in the project's language", () => {
		const { frame } = renderFrame();
		expect(frame.getAttribute("src")).toBe(`${PORTAL}/nl-NL/p1/preview`);
	});

	it("ignores a ready message from another origin or another window", () => {
		const { inner, post, ready } = renderFrame();
		ready("https://evil.example", inner);
		ready(PORTAL, window);
		ready(PORTAL, null);
		expect(post).not.toHaveBeenCalled();
	});

	it("once its frame says it is ready, sends the message to the portal's origin only", () => {
		const { inner, post, ready } = renderFrame();
		ready(PORTAL, inner);
		expect(post).toHaveBeenCalledTimes(1);
		expect(post).toHaveBeenCalledWith(message, PORTAL);
	});

	it("waits for a new language's page to say it is ready", () => {
		const german = buildPreviewMessage({
			highlight: null,
			legal: null,
			screen: "landing",
			tags: [],
			topics: undefined,
			values: portalDefaults({
				id: "p1",
				language: "de",
			} as unknown as Project),
		});
		const tree = (m: typeof message) => (
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<PortalPreviewFrame
						projectId="p1"
						message={m}
						screens={["landing"]}
						onScreen={() => {}}
						portalUrl={`${PORTAL}/`}
					/>
				</MantineProvider>
			</I18nProvider>
		);
		const view = render(tree(message));
		const say = (source: MessageEventSource | null) =>
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: PREVIEW_READY },
						origin: PORTAL,
						source,
					}),
				);
			});
		const phone = () => screen.getByTestId("portal-preview-phone");
		say(view.container.querySelector("iframe")?.contentWindow ?? null);
		expect(phone().dataset.ready).toBe("true");

		view.rerender(tree(german));
		const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
		expect(frame.getAttribute("src")).toBe(`${PORTAL}/de-DE/p1/preview`);
		expect(phone().dataset.ready).toBeUndefined();
		const post = vi
			.spyOn(frame.contentWindow as Window, "postMessage")
			.mockImplementation(() => {});
		say(frame.contentWindow);
		expect(phone().dataset.ready).toBe("true");
		expect(post).toHaveBeenCalledWith(german, PORTAL);
	});

	it("holds only the title, its i, the picker and the phone; the explanation is the i's", () => {
		renderFrame();
		const panel = screen.getByTestId("portal-preview");
		const info = screen.getByRole("button", { name: "About the preview" });
		expect(panel.contains(info)).toBe(true);
		// The words are not on the panel, but they describe the i for a screen reader.
		expect(panel.textContent).not.toContain("What participants see");
		const description = document.getElementById(
			info.getAttribute("aria-describedby") ?? "",
		);
		expect(description?.textContent).toBe(
			"What participants see, with your changes, before they are saved.",
		);
	});
});
