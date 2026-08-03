// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
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
import { RELEASES } from "./releases";
import { RELEASE_VIDEO_SEEN_KEY } from "./releaseVideo";

const LATEST = RELEASES[0];

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");

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

	it("links out to the changelog in a new tab", () => {
		renderModal();
		const link = screen.getByRole("link", { name: /see earlier releases/i });
		expect(link.getAttribute("href")).toContain("docs.dembrane.com");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toContain("noopener");
	});
});
