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
