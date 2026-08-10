// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const authState = { isAuthenticated: true };
const curtainState = { isActive: false };
const meState: { data: unknown; isSuccess: boolean } = {
	data: { settings: {} },
	isSuccess: true,
};

vi.mock("@/components/auth/hooks", () => ({
	useAuthenticated: () => authState,
}));

vi.mock("@/hooks/useV2Me", () => ({
	useV2Me: () => meState,
}));

vi.mock("@/components/layout/TransitionCurtainProvider", () => ({
	useTransitionCurtain: () => curtainState,
}));

// Captures land here instead of a network; each test reads what it needs.
const captured: Array<{ event: string; props: Record<string, unknown> }> = [];

vi.mock("@posthog/react", () => ({
	usePostHog: () => ({
		capture: (event: string, props: Record<string, unknown>) => {
			captured.push({ event, props });
		},
	}),
}));

// A non-default language, so the assertions prove the real one is carried.
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "nl-NL" }),
}));

import { ReleaseVideoModal } from "./ReleaseVideoModal";
import { getReleases } from "./releases";
import { RELEASE_VIDEO_SEEN_KEY } from "./releaseVideo";

// getReleases() resolves its copy through `t`, so a locale has to be active
// before the first call; with an empty catalog the English source comes back.
i18n.load("en", {});
i18n.activate("en");

const LATEST = getReleases()[0];

beforeAll(() => {
	// MantineProvider and usePrefersReducedMotion both read matchMedia; jsdom
	// has none, so stub a minimal always-non-matching implementation.
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

beforeEach(() => {
	authState.isAuthenticated = true;
	curtainState.isActive = false;
	meState.data = { settings: {} };
	meState.isSuccess = true;
	captured.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const renderModal = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<ReleaseVideoModal />
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

const modalIsOpen = () => screen.queryByRole("dialog") !== null;

// The gate decides whether a full-screen modal lands on someone mid-work. Each
// of these is a moment it must stay down.
describe("the release video gate", () => {
	it("opens for a user who has seen no release", () => {
		renderModal();
		expect(modalIsOpen()).toBe(true);
		expect(screen.getByText(LATEST.title)).toBeTruthy();
	});

	it("opens for a user whose last seen release is an older one", () => {
		meState.data = { settings: { [RELEASE_VIDEO_SEEN_KEY]: "1970-01" } };
		renderModal();
		expect(modalIsOpen()).toBe(true);
	});

	it("stays down once the newest release has been dismissed", () => {
		meState.data = {
			settings: { [RELEASE_VIDEO_SEEN_KEY]: LATEST.version },
		};
		renderModal();
		expect(modalIsOpen()).toBe(false);
	});

	it("stays down for a signed-out visitor", () => {
		authState.isAuthenticated = false;
		renderModal();
		expect(modalIsOpen()).toBe(false);
	});

	it("stays down while the user record is still loading", () => {
		meState.isSuccess = false;
		meState.data = undefined;
		renderModal();
		expect(modalIsOpen()).toBe(false);
	});

	it("stays down while a transition curtain is running", () => {
		curtainState.isActive = true;
		renderModal();
		expect(modalIsOpen()).toBe(false);
	});
});

describe("dismissing", () => {
	it("closes when the blurred backdrop is clicked, which is the way in", async () => {
		const { baseElement } = renderModal();
		const overlay = baseElement.querySelector(".mantine-Modal-overlay");
		expect(overlay).not.toBeNull();

		fireEvent.click(overlay as Element);

		await waitFor(() => {
			expect(modalIsOpen()).toBe(false);
		});
		await waitFor(() => {
			expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled();
		});
	});

	it("closes on escape", async () => {
		const { baseElement } = renderModal();
		fireEvent.keyDown(baseElement.querySelector('[role="dialog"]') as Element, {
			code: "Escape",
			key: "Escape",
		});

		await waitFor(() => {
			expect(modalIsOpen()).toBe(false);
		});
	});

	it("closes at once and records the newest version under a flat key", async () => {
		const { getByLabelText } = renderModal();
		getByLabelText("Close and go to dembrane").click();

		await waitFor(() => {
			expect(modalIsOpen()).toBe(false);
		});

		const fetchMock = vi.mocked(globalThis.fetch);
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/v2/me");
		expect(init?.method).toBe("PATCH");

		// Only the one flat key goes over the wire. The server merges settings
		// one level deep, so sending exactly this cannot disturb a sibling.
		const body = JSON.parse(String(init?.body));
		expect(body).toEqual({
			settings: { [RELEASE_VIDEO_SEEN_KEY]: LATEST.version },
		});
		expect(Object.keys(body.settings)).toHaveLength(1);
	});
});

// The automatic showing is spent after one dismissal, so the sidebar entry is
// the only way back to the video. It has to ignore the seen gate entirely.
describe("opening it on demand", () => {
	// HelpBlock owns this flag through useDisclosure and hands it down.
	const OnDemand = () => {
		const [requested, handlers] = useDisclosure(false);
		return (
			<>
				<button type="button" onClick={handlers.open}>
					What's new
				</button>
				<ReleaseVideoModal
					requested={requested}
					onRequestedClose={handlers.close}
				/>
			</>
		);
	};

	const renderOnDemand = () =>
		render(
			<QueryClientProvider client={new QueryClient()}>
				<I18nProvider i18n={i18n}>
					<MantineProvider>
						<OnDemand />
					</MantineProvider>
				</I18nProvider>
			</QueryClientProvider>,
		);

	beforeEach(() => {
		meState.data = { settings: { [RELEASE_VIDEO_SEEN_KEY]: LATEST.version } };
	});

	it("opens for a user who already dismissed the newest release", async () => {
		renderOnDemand();
		expect(modalIsOpen()).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "What's new" }));
		await waitFor(() => {
			expect(modalIsOpen()).toBe(true);
		});
	});

	it("can be opened again after being closed", async () => {
		renderOnDemand();
		const trigger = screen.getByRole("button", { name: "What's new" });

		fireEvent.click(trigger);
		await waitFor(() => {
			expect(modalIsOpen()).toBe(true);
		});

		fireEvent.click(screen.getByLabelText("Close and go to dembrane"));
		await waitFor(() => {
			expect(modalIsOpen()).toBe(false);
		});

		fireEvent.click(trigger);
		await waitFor(() => {
			expect(modalIsOpen()).toBe(true);
		});
	});
});

// What the analytics must answer: did they watch, how far, in which language,
// from which trigger. The player never loads in jsdom, so the widget messages
// are hand-delivered exactly as the embed would post them.
describe("analytics", () => {
	const EMBED_ORIGIN = "https://www.youtube-nocookie.com";

	const capturesOf = (event: string) =>
		captured.filter((capture) => capture.event === event);

	const frameElement = () =>
		screen.getByTitle("Release video") as HTMLIFrameElement;

	const deliver = (info: Record<string, unknown>) => {
		fireEvent(
			window,
			new MessageEvent("message", {
				data: JSON.stringify({ event: "infoDelivery", info }),
				origin: EMBED_ORIGIN,
				source: frameElement().contentWindow,
			}),
		);
	};

	it("records the automatic showing with language, version and trigger", () => {
		renderModal();
		const opens = capturesOf("whats_new_modal_opened");
		expect(opens).toHaveLength(1);
		expect(opens[0].props).toMatchObject({
			language: "nl-NL",
			trigger: "auto",
			version: LATEST.version,
		});
		expect(typeof opens[0].props.seconds_since_page_load).toBe("number");
	});

	it("marks a sidebar showing as manual", async () => {
		meState.data = { settings: { [RELEASE_VIDEO_SEEN_KEY]: LATEST.version } };
		const Reopen = () => {
			const [requested, handlers] = useDisclosure(false);
			return (
				<>
					<button onClick={handlers.open} type="button">
						What's new
					</button>
					<ReleaseVideoModal
						onRequestedClose={handlers.close}
						requested={requested}
					/>
				</>
			);
		};
		render(
			<QueryClientProvider client={new QueryClient()}>
				<I18nProvider i18n={i18n}>
					<MantineProvider>
						<Reopen />
					</MantineProvider>
				</I18nProvider>
			</QueryClientProvider>,
		);
		expect(capturesOf("whats_new_modal_opened")).toHaveLength(0);

		fireEvent.click(screen.getByRole("button", { name: "What's new" }));
		await waitFor(() => {
			expect(capturesOf("whats_new_modal_opened")).toHaveLength(1);
		});
		expect(capturesOf("whats_new_modal_opened")[0].props.trigger).toBe(
			"manual",
		);
	});

	it("turns the embed's own messages into started, progress and completed", () => {
		renderModal();
		deliver({ currentTime: 0, duration: 100, playerState: 1 });
		deliver({ currentTime: 1 });
		deliver({ currentTime: 2 });
		expect(capturesOf("whats_new_video_started")).toHaveLength(1);

		deliver({ currentTime: 30 });
		const progress = capturesOf("whats_new_video_progress");
		expect(progress).toHaveLength(1);
		expect(progress[0].props.milestone_percent).toBe(25);

		deliver({ currentTime: 100, playerState: 0 });
		expect(capturesOf("whats_new_video_progress")).toHaveLength(4);
		const completed = capturesOf("whats_new_video_completed");
		expect(completed).toHaveLength(1);
		expect(completed[0].props.video_duration_seconds).toBe(100);
	});

	it("ignores messages that are not from the embed", () => {
		renderModal();
		fireEvent(
			window,
			new MessageEvent("message", {
				data: JSON.stringify({
					event: "infoDelivery",
					info: { playerState: 1 },
				}),
				origin: "https://www.youtube.com",
				source: frameElement().contentWindow,
			}),
		);
		fireEvent(
			window,
			new MessageEvent("message", {
				data: JSON.stringify({
					event: "infoDelivery",
					info: { playerState: 1 },
				}),
				origin: EMBED_ORIGIN,
				source: window,
			}),
		);
		expect(capturesOf("whats_new_video_started")).toHaveLength(0);
	});

	it("reports an unwatched showing when closed without playing", async () => {
		renderModal();
		screen.getByLabelText("Close and go to dembrane").click();
		await waitFor(() => {
			expect(capturesOf("whats_new_modal_closed")).toHaveLength(1);
		});
		expect(capturesOf("whats_new_modal_closed")[0].props).toMatchObject({
			reason: "dismissed",
			video_watched: false,
			video_watched_seconds: 0,
		});
	});

	it("carries the watch summary on close", async () => {
		renderModal();
		deliver({ currentTime: 0, duration: 100, playerState: 1 });
		deliver({ currentTime: 1 });
		deliver({ currentTime: 2 });

		screen.getByLabelText("Close and go to dembrane").click();
		await waitFor(() => {
			expect(capturesOf("whats_new_modal_closed")).toHaveLength(1);
		});
		const summary = capturesOf("whats_new_modal_closed")[0].props;
		expect(summary).toMatchObject({
			video_duration_seconds: 100,
			video_watched: true,
			video_watched_seconds: 2,
		});
		expect(summary.video_max_percent).toBe(2);
	});

	it("flushes the summary once when the tab goes, not again on close", async () => {
		renderModal();
		fireEvent(window, new Event("pagehide"));
		expect(capturesOf("whats_new_modal_closed")).toHaveLength(1);
		expect(capturesOf("whats_new_modal_closed")[0].props.reason).toBe(
			"pagehide",
		);

		screen.getByLabelText("Close and go to dembrane").click();
		await waitFor(() => {
			expect(modalIsOpen()).toBe(false);
		});
		expect(capturesOf("whats_new_modal_closed")).toHaveLength(1);
	});
});

describe("typography", () => {
	it("renders nothing italic", () => {
		const { baseElement } = renderModal();
		const italics = Array.from(
			baseElement.querySelectorAll<HTMLElement>("*"),
		).filter((node) => {
			const style = node.getAttribute("style") ?? "";
			return (
				style.includes("italic") ||
				node.className.toString().includes("italic") ||
				["EM", "I"].includes(node.tagName)
			);
		});
		expect(italics).toHaveLength(0);
	});

	it("frames the video from the one origin the CSP allows", () => {
		renderModal();
		const frame = screen.getByTitle("Release video") as HTMLIFrameElement;
		expect(frame.getAttribute("src")).toContain(
			"https://www.youtube-nocookie.com/embed/",
		);
	});

	// Mantine applies a `style` prop on Modal.Content to the full-viewport
	// .inner wrapper as well as to the panel. Painting a background there
	// covers the overlay and the modal arrives with no visible scrim, which is
	// what "styles" (keyed by selector) avoids.
	it("leaves the overlay visible by not painting the inner wrapper", () => {
		const { baseElement } = renderModal();
		const inner = baseElement.querySelector(".mantine-Modal-inner");
		expect(inner).not.toBeNull();
		expect(inner?.getAttribute("style") ?? "").not.toContain("background");

		const overlay = baseElement.querySelector(".mantine-Modal-overlay");
		expect(overlay?.getAttribute("style") ?? "").toContain(
			"--overlay-bg: rgba(0, 0, 0, 0.6)",
		);
	});

	it("titles the header and points at the Feedback button", () => {
		renderModal();
		expect(screen.getByText("Message from the dembrane team")).toBeTruthy();
		expect(screen.getByText(/Feedback button/i)).toBeTruthy();
	});
});
