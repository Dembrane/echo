// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { BroadcastIcon, BugIcon } from "@phosphor-icons/react";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));
vi.mock("@/components/common/Logo", () => ({
	Logo: () => <img alt="" />,
}));
vi.mock("@/components/release/ReleaseVideoModal", () => ({
	ReleaseVideoModal: () => null,
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspaces: [] }),
}));
vi.mock("../hooks/useSearchHits", () => ({
	useSearchHits: () => ({ hits: [], isFetching: false }),
}));
vi.mock("@/components/auth/hooks", () => ({
	useAuthenticated: () => ({ isAuthenticated: true }),
	useCurrentUser: () => ({
		data: { email: "jorim@example.org", first_name: "Jorim" },
	}),
	useLogoutMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: {} }) }));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("@/components/layout/TransitionCurtainProvider", () => ({
	useTransitionCurtain: () => ({ runTransition: vi.fn() }),
}));
vi.mock("@/components/common/UserAvatar", () => ({
	UserAvatar: () => <span data-testid="avatar" />,
}));
vi.mock("@/components/language/LanguagePicker", () => ({
	LanguagePicker: () => null,
}));
vi.mock("@/components/organisation/CreateOrganisationModal", () => ({
	CreateOrganisationModal: () => null,
}));
vi.mock("../hooks/useHelpModals", () => ({
	useHelpModals: () => ({ openFeedback: vi.fn(), openReportIssue: vi.fn() }),
}));

const { NavItem } = await import("../primitives/NavItem");
const { NavButton } = await import("../primitives/NavButton");
const { SectionLabel } = await import("../primitives/SectionLabel");
const { HelpBlock } = await import("../blocks/HelpBlock");
const { BackButton } = await import("../primitives/BackButton");
const { ViewHeader } = await import("../primitives/ViewHeader");
const { SearchBlock } = await import("../blocks/SearchBlock");
const { UserMenu } = await import("./UserMenu");
const { SidebarHeader } = await import("./SidebarHeader");
const { SidebarShell } = await import("./SidebarShell");
const { FullOnly, RAIL_WIDTH, RailProvider, useInRail } = await import(
	"./rail"
);

function stubMatchMedia(matches: boolean) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockImplementation((media: string) => ({
			addEventListener: vi.fn(),
			addListener: vi.fn(),
			dispatchEvent: vi.fn(),
			matches: media === "(max-width: 767px)" ? matches : false,
			media,
			onchange: null,
			removeEventListener: vi.fn(),
			removeListener: vi.fn(),
		})),
	);
}

const LocationProbe = () => {
	const { pathname, search } = useLocation();
	return <output data-testid="location">{`${pathname}${search}`}</output>;
};

const renderIn = (
	ui: ReactNode,
	{ inRail = true, url = "/en-US/start" } = {},
) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<MemoryRouter initialEntries={[url]}>
					<RailProvider inRail={inRail}>{ui}</RailProvider>
					<LocationProbe />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

const location = () => screen.getByTestId("location").textContent;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	window.localStorage.clear();
	stubMatchMedia(false);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("a menu item in the rail", () => {
	it("is an icon link named by its label, with the label hidden from sight", () => {
		renderIn(<NavItem to="/monitor" label="Monitor" icon={BroadcastIcon} />);
		const link = screen.getByRole("link", { name: "Monitor" });
		expect(link.querySelector("svg")).not.toBeNull();
		expect(screen.getByText("Monitor").className).toContain("sr-only");
	});

	it("shows its name in a tooltip on hover", () => {
		renderIn(<NavItem to="/monitor" label="Monitor" icon={BroadcastIcon} />);
		expect(screen.queryByRole("tooltip")).toBeNull();
		fireEvent.mouseEnter(screen.getByRole("link", { name: "Monitor" }));
		expect(screen.getByRole("tooltip").textContent).toBe("Monitor");
	});

	it("shows its name in a tooltip on keyboard focus, and Escape closes it", () => {
		renderIn(<NavItem to="/monitor" label="Monitor" icon={BroadcastIcon} />);
		const link = screen.getByRole("link", { name: "Monitor" });
		fireEvent.focus(link);
		expect(screen.getByRole("tooltip").textContent).toBe("Monitor");
		fireEvent.keyDown(link, { key: "Escape" });
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("held on a touch screen, shows its name and does not navigate on release", () => {
		vi.useFakeTimers();
		renderIn(<NavItem to="/monitor" label="Monitor" icon={BroadcastIcon} />);
		const link = screen.getByRole("link", { name: "Monitor" });
		fireEvent.touchStart(link);
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(screen.getByRole("tooltip").textContent).toBe("Monitor");
		fireEvent.touchEnd(link);
		fireEvent.click(link);
		expect(location()).toBe("/en-US/start");
	});

	it("tapped quickly, navigates without a tooltip", () => {
		vi.useFakeTimers();
		renderIn(<NavItem to="/monitor" label="Monitor" icon={BroadcastIcon} />);
		const link = screen.getByRole("link", { name: "Monitor" });
		fireEvent.touchStart(link);
		act(() => {
			vi.advanceTimersByTime(100);
		});
		fireEvent.touchEnd(link);
		fireEvent.click(link);
		expect(screen.queryByRole("tooltip")).toBeNull();
		expect(location()).toBe("/en-US/monitor");
	});

	it("carries a count in its tooltip and its accessible name", () => {
		renderIn(
			<NavItem
				to="/conversations"
				label="Conversations"
				icon={BroadcastIcon}
				badge={42}
			/>,
		);
		const link = screen.getByRole("link", { name: /Conversations\s+42/ });
		fireEvent.mouseEnter(link);
		expect(screen.getByRole("tooltip").textContent).toMatch(
			/Conversations\s*42/,
		);
	});

	it("shows a dot for a badge that asks for attention, not for a muted one", () => {
		const { rerender } = renderIn(
			<NavItem
				to="/inbox"
				label="Inbox"
				icon={BroadcastIcon}
				badge={3}
				badgeTone="notification"
			/>,
		);
		expect(screen.getByTestId("rail-badge-dot")).toBeTruthy();
		rerender(
			<I18nProvider i18n={i18n}>
				<MantineProvider env="test">
					<MemoryRouter>
						<RailProvider inRail>
							<NavItem
								to="/monitor"
								label="Monitor"
								icon={BroadcastIcon}
								badge="Beta"
							/>
						</RailProvider>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>,
		);
		expect(screen.queryByTestId("rail-badge-dot")).toBeNull();
	});

	it("is left out when it has no icon", () => {
		renderIn(<NavItem to="/updates" label="Message from dembrane" inset />);
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("keeps its full row outside the rail", () => {
		renderIn(<NavItem to="/monitor" label="Monitor" icon={BroadcastIcon} />, {
			inRail: false,
		});
		expect(screen.getByText("Monitor").className).not.toContain("sr-only");
	});
});

describe("a button item in the rail", () => {
	it("is an icon button named by its label", () => {
		const onClick = vi.fn();
		renderIn(
			<NavButton label="Report an issue" icon={BugIcon} onClick={onClick} />,
		);
		const button = screen.getByRole("button", { name: "Report an issue" });
		expect(screen.getByText("Report an issue").className).toContain("sr-only");
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledOnce();
	});
});

describe("section labels and lists of things", () => {
	it("render nothing in the rail", () => {
		renderIn(
			<>
				<SectionLabel>Pinned projects</SectionLabel>
				<FullOnly>
					<span>Bloom</span>
				</FullOnly>
			</>,
		);
		expect(screen.queryByText("Pinned projects")).toBeNull();
		expect(screen.queryByText("Bloom")).toBeNull();
	});

	it("render as before in the full sidebar", () => {
		renderIn(
			<>
				<SectionLabel>Pinned projects</SectionLabel>
				<FullOnly>
					<span>Bloom</span>
				</FullOnly>
			</>,
			{ inRail: false },
		);
		expect(screen.getByText("Pinned projects")).toBeTruthy();
		expect(screen.getByText("Bloom")).toBeTruthy();
	});
});

describe("help in the rail", () => {
	it("folds into one icon that opens the Help view", () => {
		renderIn(<HelpBlock />, { url: "/en-US/o" });
		const links = screen.getAllByRole("link");
		expect(links).toHaveLength(1);
		expect(links[0].getAttribute("aria-label") ?? links[0].textContent).toBe(
			"Help",
		);
		expect(links[0].getAttribute("href")).toBe("/en-US/o?sidebar=help");
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("the back arrows in the rail", () => {
	it("the section title becomes an arrow icon named by the place you are in", () => {
		renderIn(<BackButton to="/o" label="Bloom" center />);
		const link = screen.getByRole("link", { name: "Bloom" });
		expect(link.querySelector("svg")).not.toBeNull();
		expect(screen.getByText("Bloom").className).toContain("sr-only");
		fireEvent.mouseEnter(link);
		expect(screen.getByRole("tooltip").textContent).toBe("Bloom");
	});

	it("a pushed view's header becomes an arrow icon named by its title", () => {
		renderIn(<ViewHeader to="/o" title="Help" />);
		const link = screen.getByRole("link", { name: "Help" });
		expect(link.querySelector("svg")).not.toBeNull();
		expect(screen.getByText("Help").className).toContain("sr-only");
	});
});

describe("search and the account in the rail", () => {
	it("search is an icon button whose tooltip carries the shortcut", () => {
		renderIn(<SearchBlock />);
		const button = screen.getByRole("button", { name: "Search" });
		expect(button.querySelector("svg")).not.toBeNull();
		fireEvent.mouseEnter(button);
		expect(screen.getByRole("tooltip").textContent).toMatch(/Search.*K/);
	});

	it("the account menu is the avatar alone, named by the person", () => {
		renderIn(<UserMenu />);
		const button = screen.getByRole("button", { name: "Jorim" });
		expect(button.querySelector("[data-testid=avatar]")).not.toBeNull();
		expect(screen.queryByText("jorim@example.org")).toBeNull();
	});
});

describe("the header in the rail", () => {
	it("shows the logomark linking home, with the open-menu button under it", () => {
		renderIn(<SidebarHeader />);
		const home = screen.getByRole("link", { name: "dembrane home" });
		const open = screen.getByRole("button", { name: "Open menu" });
		expect(
			home.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		fireEvent.click(open);
		expect(window.localStorage.getItem("dembrane.sidebar.collapsed")).toBe(
			"false",
		);
	});

	it("keeps the full logo and the collapse button when open", () => {
		renderIn(<SidebarHeader />, { inRail: false });
		expect(screen.getByRole("link", { name: "dembrane home" })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Collapse sidebar" }),
		).toBeTruthy();
	});
});

describe("the shell", () => {
	const RailProbe = () => (
		<span data-testid="mode">{useInRail() ? "rail" : "full"}</span>
	);
	const renderShell = () =>
		render(
			<MantineProvider env="test">
				<MemoryRouter>
					<SidebarShell>
						<RailProbe />
					</SidebarShell>
				</MemoryRouter>
			</MantineProvider>,
		);

	it("desktop collapsed: a rail, not gone", () => {
		window.localStorage.setItem("dembrane.sidebar.collapsed", "true");
		renderShell();
		const aside = document.querySelector("aside");
		expect(aside?.style.width).toBe(`${RAIL_WIDTH}px`);
		expect(screen.getByTestId("mode").textContent).toBe("rail");
	});

	it("desktop open: the full sidebar", () => {
		renderShell();
		expect(screen.getByTestId("mode").textContent).toBe("full");
	});

	it("phone at rest: the rail, in the page flow, with no backdrop", () => {
		stubMatchMedia(true);
		window.localStorage.setItem("dembrane.sidebar.collapsed", "true");
		renderShell();
		const aside = document.querySelector("aside");
		expect(aside?.style.width).toBe(`${RAIL_WIDTH}px`);
		expect(aside?.className).toContain("relative");
		expect(screen.queryByTestId("sidebar-mobile-backdrop")).toBeNull();
		expect(screen.getByTestId("mode").textContent).toBe("rail");
	});
});
