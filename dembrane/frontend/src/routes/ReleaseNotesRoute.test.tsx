// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import * as releases from "@/components/release/releases";
import { ReleaseNotesRoute } from "./ReleaseNotesRoute";

i18n.load("en-GB", {});
i18n.activate("en-GB");
beforeAll(() => {
	window.matchMedia = vi.fn().mockImplementation((query) => ({
		addEventListener() {},
		matches: false,
		media: query,
		removeEventListener() {},
	}));
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
const Location = () => (
	<output data-testid="location">{useLocation().search}</output>
);
const show = (path = "/en-US/release-notes") =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={[path]}>
					<ReleaseNotesRoute />
					<Location />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

it("keeps each walkthrough with its own release, captions on", () => {
	const history = releases.getReleases();
	show();
	const articles = screen.getAllByRole("article");
	expect(articles).toHaveLength(history.length);
	expect(
		within(articles[0]).getByRole("heading", { name: history[0].title }),
	).toBeTruthy();
	expect(within(articles[0]).queryByText("Upcoming")).toBeNull();
	expect(
		within(articles[0]).getByRole("link", { name: "v2.4.0" }),
	).toBeTruthy();
	expect(within(articles[0]).getByText("Latest release")).toBeTruthy();
	expect(within(articles[1]).queryByText("Latest release")).toBeNull();
	expect(articles[0].querySelector("iframe")?.src).toContain(
		"youtube-nocookie.com/embed/nKFxtUr13sI?rel=0&cc_load_policy=1&cc_lang_pref=en",
	);
	expect(
		within(articles[1]).getByRole("heading", { name: history[1].title }),
	).toBeTruthy();
	const walkthrough = articles.find((article) =>
		within(article).queryByRole("link", { name: "v2.2.0" }),
	);
	expect(walkthrough?.querySelector("iframe")?.src).toContain(
		"youtube-nocookie.com",
	);
	expect(screen.getAllByText("Latest release")).toHaveLength(1);
});

it("renders Markdown and keeps unsafe video URLs out of the page", () => {
	vi.spyOn(releases, "getReleases").mockReturnValue([
		{
			description: "### Changes\n\n- One improvement\n- Another improvement",
			title: "An update",
			version: "test",
			videoUrl: "https://untrusted.example/embed/video",
		},
	]);
	const { container } = show();
	expect(screen.getByRole("heading", { name: "Changes" })).toBeTruthy();
	expect(
		within(screen.getByRole("article")).getAllByRole("listitem"),
	).toHaveLength(2);
	expect(container.querySelector("iframe")).toBeNull();
});

it("handles an empty history", () => {
	vi.spyOn(releases, "getReleases").mockReturnValue([]);
	show();
	expect(screen.getByText("No release notes yet.")).toBeTruthy();
});

it("links published versions to verified release pages and preserves real tag names", () => {
	show();
	for (const tag of ["v2.3.0", "v2.2.0", "v1.5", "v1.0.0"]) {
		const link = screen.getByRole("link", { name: tag });
		expect(link.getAttribute("href")).toBe(
			`https://github.com/dembrane/echo/releases/tag/${tag}`,
		);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toContain("noopener");
	}
	expect(
		screen.getByRole("link", { name: "v2.1.0" }).getAttribute("href"),
	).toBe("https://github.com/dembrane/echo/tree/v2.1.0");
	expect(screen.getByText("31 August 2026").getAttribute("datetime")).toBe(
		"2026-08-31",
	);
	expect(screen.queryByText("2026-09")).toBeNull();
});

it("groups releases by month and keeps the same month in different years separate", () => {
	show();
	const august2026 = screen.getByRole("region", { name: "August 2026" });
	const august2025 = screen.getByRole("region", { name: "August 2025" });
	expect(within(august2026).getByRole("link", { name: "v2.3.0" })).toBeTruthy();
	expect(within(august2026).queryByRole("link", { name: "v1.9.0" })).toBeNull();
	expect(within(august2025).getByRole("link", { name: "v1.9.0" })).toBeTruthy();
	expect(within(august2025).queryByRole("link", { name: "v2.3.0" })).toBeNull();
	expect(screen.queryByRole("region", { name: "Next" })).toBeNull();
	expect(
		within(screen.getByRole("region", { name: "September 2026" })).getByRole(
			"heading",
			{ name: "Introducing Popcorn" },
		),
	).toBeTruthy();
});

it("marks editorial milestones while retaining all patch details and links", () => {
	show();
	const milestone = screen
		.getByRole("link", { name: "v2.0.0" })
		.closest("article");
	const patch = screen.getByRole("link", { name: "v2.0.3" }).closest("article");
	expect(milestone?.textContent).toContain("Highlight");
	expect(patch?.textContent).not.toContain("Highlight");
	expect(patch?.textContent).toContain(
		"Choose discoverable, invite-only or private workspaces.",
	);
});

it("groups changes by category independently of the release's version", () => {
	show();
	const patch = screen.getByRole("link", { name: "v2.0.3" }).closest("article");
	if (!patch) throw new Error("Missing patch release");
	expect(patch.getAttribute("data-layout")).toBe("patch");
	expect(
		within(within(patch).getByRole("list", { name: "New features" })).getByText(
			"Choose discoverable, invite-only or private workspaces.",
		),
	).toBeTruthy();
	expect(
		within(within(patch).getByRole("list", { name: "Improvements" })).getByText(
			"Organisation members load faster.",
		),
	).toBeTruthy();
	expect(
		within(within(patch).getByRole("list", { name: "Bug fixes" })).getByText(
			"Automatic summaries, conversation merging and durations work more reliably.",
		),
	).toBeTruthy();
});

it("shows each category once and omits empty groups", () => {
	show();
	const popcorn = screen
		.getByRole("heading", { name: "Introducing Popcorn" })
		.closest("article");
	if (!popcorn) throw new Error("Missing Popcorn release");
	for (const name of ["New features", "Improvements", "Bug fixes"]) {
		expect(within(popcorn).getAllByRole("heading", { name })).toHaveLength(1);
	}
	expect(within(popcorn).getAllByRole("listitem")).toHaveLength(
		releases.getReleases()[0].changes?.length ?? 0,
	);
	const fix = screen.getByRole("link", { name: "v2.1.1" }).closest("article");
	if (!fix) throw new Error("Missing Czech fix release");
	expect(
		within(fix).queryByRole("heading", { name: "New features" }),
	).toBeNull();
	expect(
		within(fix).queryByRole("heading", { name: "Improvements" }),
	).toBeNull();
	expect(within(fix).getByRole("list", { name: "Bug fixes" })).toBeTruthy();
});

it("keeps launch details as separate bullets", () => {
	show();
	const reportRelease = screen
		.getByRole("link", { name: "v1.17.0" })
		.closest("article");
	if (!reportRelease) throw new Error("Missing report release");
	expect(within(reportRelease).getAllByRole("listitem")).toHaveLength(14);
	expect(
		within(reportRelease).getByText(
			"Schedule reports (beta) to include all conversations recorded before the chosen time.",
		),
	).toBeTruthy();
	expect(
		within(reportRelease).getByText(
			"Report generation continues in the background with a visible status.",
		),
	).toBeTruthy();
	expect(
		within(reportRelease).getByText(
			"Use Ukrainian for chat and participant replies.",
		),
	).toBeTruthy();
});

it("credits pilot after the oldest release without mixing repository versions", () => {
	show();
	const pilot = screen.getByRole("region", {
		name: "Before this release history",
	});
	const firstRelease = screen
		.getByRole("link", { name: "v1.0.0" })
		.closest("article");
	if (!firstRelease) throw new Error("Missing first release");
	expect(
		firstRelease.compareDocumentPosition(pilot) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(within(pilot).getAllByRole("listitem")).toHaveLength(4);
	expect(
		within(pilot)
			.getByRole("link", { name: "Explore the dembrane/pilot archive" })
			.getAttribute("href"),
	).toBe("https://github.com/Dembrane/pilot/releases");
	expect(within(pilot).queryByRole("link", { name: "v1.0.0" })).toBeNull();
});
