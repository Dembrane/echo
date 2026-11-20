// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { NotificationRow } from "@/hooks/useNotifications";
import { Inbox } from "./Inbox";

const navigate = vi.fn();
const markNotifRead = vi.fn();
const markAllNotifsRead = vi.fn();
const markAllAnnouncementsRead = vi.fn();
let notifications: (Partial<NotificationRow> & { href?: string })[] = [];
let announcements: { id: string; read: boolean; title: string }[] = [];

vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en" }),
}));
vi.mock("@/hooks/useNotifications", () => ({
	resolveNotificationHref: (row: NotificationRow) =>
		(row as { href?: string }).href ?? null,
	useMarkAllNotificationsRead: () => ({
		isPending: false,
		mutate: markAllNotifsRead,
	}),
	useMarkNotificationRead: () => ({ mutate: markNotifRead }),
	useNotifications: () => ({ data: notifications, isLoading: false }),
	useUnreadNotificationCount: () => ({
		data: notifications.filter((n) => !n.read).length,
	}),
}));
vi.mock("@/components/announcement/hooks", () => ({
	useInfiniteAnnouncements: () => ({
		data: { pages: [{ announcements }] },
		fetchNextPage: vi.fn(),
		hasNextPage: false,
		isFetchingNextPage: false,
		isLoading: false,
	}),
	useMarkAllAsReadMutation: () => ({
		isPending: false,
		mutate: markAllAnnouncementsRead,
	}),
	useMarkAsReadMutation: () => ({ mutate: vi.fn() }),
	useMarkAsUnreadMutation: () => ({ mutate: vi.fn() }),
	useUnreadAnnouncements: () => ({
		data: announcements.filter((a) => !a.read).length,
	}),
}));
vi.mock("@/components/announcement/hooks/useProcessedAnnouncements", () => ({
	useProcessedAnnouncements: (rows: unknown[]) => rows,
}));
vi.mock("@/components/announcement/AnnouncementItem", () => ({
	AnnouncementItem: ({ announcement }: { announcement: { title: string } }) => (
		<div data-testid="announcement">{announcement.title}</div>
	),
}));
vi.mock("react-intersection-observer", () => ({
	useInView: () => ({ inView: false, ref: () => {} }),
}));

i18n.loadAndActivate({ locale: "en", messages: {} });

beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
	globalThis.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	};
});

beforeEach(() => {
	vi.clearAllMocks();
	notifications = [
		{ href: "/w/1", id: "n1", read: false, title: "Added to **Team**" },
		{ id: "n2", read: true, title: "Old news" },
	];
	announcements = [
		{ id: "a1", read: true, title: "Read one" },
		{ id: "a2", read: false, title: "Unread one" },
	];
});

afterEach(cleanup);

const show = () => {
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<Inbox />
			</MantineProvider>
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
};

describe("Inbox", () => {
	it("opens on For you, with the bold parts of a title in bold", async () => {
		show();
		const strong = await screen.findByText("Team");
		expect(strong.tagName).toBe("STRONG");
		expect(screen.getByText("Old news")).toBeTruthy();
	});

	it("marks all read on the tab that is showing", async () => {
		show();
		fireEvent.click(
			await screen.findByRole("button", { name: "Mark all read" }),
		);
		expect(markAllNotifsRead).toHaveBeenCalledTimes(1);
		expect(markAllAnnouncementsRead).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("tab", { name: /Announcements/ }));
		fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
		expect(markAllAnnouncementsRead).toHaveBeenCalledTimes(1);
		expect(markAllNotifsRead).toHaveBeenCalledTimes(1);
	});

	it("lists unread announcements before read ones", async () => {
		show();
		fireEvent.click(await screen.findByRole("tab", { name: /Announcements/ }));
		const titles = (await screen.findAllByTestId("announcement")).map(
			(a) => a.textContent,
		);
		expect(titles).toEqual(["Unread one", "Read one"]);
	});

	it("an unread notification with a link is marked read and followed", async () => {
		show();
		fireEvent.click(await screen.findByText("Team"));
		expect(markNotifRead).toHaveBeenCalledWith("n1");
		expect(navigate).toHaveBeenCalledWith("/w/1");
	});

	it("a read notification without a link does nothing", async () => {
		show();
		fireEvent.click(await screen.findByText("Old news"));
		expect(markNotifRead).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it("marks an unread row read from its button, without following it", async () => {
		show();
		fireEvent.click(
			await screen.findByRole("button", { name: "Mark as read" }),
		);
		expect(markNotifRead).toHaveBeenCalledWith("n1");
		expect(navigate).not.toHaveBeenCalled();
	});
});
