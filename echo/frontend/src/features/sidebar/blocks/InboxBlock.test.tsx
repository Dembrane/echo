// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pendingActions: 0,
	unreadAnnouncements: 0,
	unreadNotifications: 0,
	urgent: null as {
		translations: { languages_code: string; title: string }[];
	} | null,
}));

vi.mock("@/components/announcement/hooks", () => ({
	useTopUrgentUnreadAnnouncement: () => ({ data: mocks.urgent }),
	useUnreadAnnouncements: () => ({ data: mocks.unreadAnnouncements }),
}));
vi.mock("@/hooks/useNotifications", () => ({
	useUnreadNotificationCount: () => ({ data: mocks.unreadNotifications }),
}));
vi.mock("../hooks/usePendingActions", () => ({
	usePendingActionCount: () => mocks.pendingActions,
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));

const { InboxBlock } = await import("./InboxBlock");

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const renderBlock = (url = "/en-US/o") =>
	render(
		<I18nProvider i18n={i18n}>
			<MemoryRouter initialEntries={[url]}>
				<InboxBlock />
			</MemoryRouter>
		</I18nProvider>,
	);

const activeRows = () =>
	screen
		.getAllByRole("link")
		.filter((a) => a.querySelector("span.absolute") !== null)
		.map((a) => a.textContent?.trim());

/** Every link the block renders, as [accessible name, href]. */
const links = () =>
	screen
		.getAllByRole("link")
		.map((a) => [a.textContent?.trim(), a.getAttribute("href")]);

beforeEach(() => {
	mocks.pendingActions = 0;
	mocks.unreadAnnouncements = 0;
	mocks.unreadNotifications = 0;
	mocks.urgent = null;
});

afterEach(cleanup);

it("renders only the Inbox row when no announcement is unread", () => {
	mocks.unreadNotifications = 2;
	renderBlock();
	expect(links()).toEqual([["Inbox2", "/en-US/o?sidebar=inbox"]]);
});

it("adds an inset sub-row pointing at Updates when an announcement is unread", () => {
	mocks.unreadAnnouncements = 1;
	renderBlock();
	expect(links()).toEqual([
		["Inbox1", "/en-US/o?sidebar=inbox"],
		["Message from dembrane", "/en-US/o?sidebar=inbox&sidebar-tab=updates"],
	]);
});

it("counts announcements once, on the Inbox row only", () => {
	mocks.unreadNotifications = 2;
	mocks.unreadAnnouncements = 3;
	renderBlock();
	const [inbox, sub] = links();
	expect(inbox[0]).toBe("Inbox5");
	expect(sub[0]).toBe("Messages from dembrane");
});

it("shows the urgent title in place of the static label", () => {
	mocks.unreadAnnouncements = 2;
	mocks.urgent = {
		translations: [{ languages_code: "en-US", title: "Scheduled maintenance" }],
	};
	renderBlock();
	expect(links()[1][0]).toBe("Scheduled maintenance");
});

it("keeps the Inbox row selected on the Updates tab once everything is read", () => {
	// The sub-row is gone, so nothing else can hold the selection.
	renderBlock("/en-US/o?sidebar=inbox&sidebar-tab=updates");
	expect(activeRows()).toEqual(["Inbox"]);
});

it("hands the selection to the sub-row on the Updates tab while unread", () => {
	mocks.unreadAnnouncements = 1;
	renderBlock("/en-US/o?sidebar=inbox&sidebar-tab=updates");
	expect(activeRows()).toEqual(["Message from dembrane"]);
});

it("selects the Inbox row on the For you tab", () => {
	mocks.unreadAnnouncements = 1;
	renderBlock("/en-US/o?sidebar=inbox");
	expect(activeRows()).toEqual(["Inbox1"]);
});
