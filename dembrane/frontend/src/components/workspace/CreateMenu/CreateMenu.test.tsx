// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAccess } from "./access";
import { CreateMenu } from "./CreateMenu";
import { orderWorkspaces } from "./WhichWorkspaceModal";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia ||= ((query: string) =>
		({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}) as unknown as MediaQueryList) as typeof window.matchMedia;
	globalThis.ResizeObserver ||= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const team = { id: "w-team", name: "Team", orgName: "Gemeente Utrecht" };
const lab = { id: "w-lab", name: "Lab", orgName: "Gemeente Utrecht" };
const pilot = { id: "w-pilot", name: "Pilot", orgName: "Atelier" };

/** Home's form: every item. */
const renderMenu = (
	props: {
		projectWorkspaces?: ComponentProps<typeof CreateMenu>["projectWorkspaces"];
		lastWorkspaceId?: string | null;
		onWorkspace?: () => void;
		orgCapped?: boolean;
	} = {},
) => {
	const handlers = {
		onOrganisation: vi.fn(),
		onProject: vi.fn(),
		onWorkspace: vi.fn(),
	};
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<CreateMenu
					projectWorkspaces={[team]}
					lastWorkspaceId={null}
					orgCapped={false}
					{...handlers}
					{...props}
				/>
			</MantineProvider>
		</I18nProvider>,
	);
	return handlers;
};

/** Workspace home's form: its one workspace, the project items only. */
const renderProjectMenu = (onProjectCap?: () => void) => {
	const onProject = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<CreateMenu
					projectWorkspaces={[team]}
					onProject={onProject}
					onProjectCap={onProjectCap}
				/>
			</MantineProvider>
		</I18nProvider>,
	);
	return onProject;
};

const open = () => fireEvent.click(screen.getByTestId("create-menu-button"));
const items = () =>
	screen.getAllByRole("menuitem").map((el) => el.textContent?.trim());

describe("who may create what", () => {
	const ws = (id: string, role: string, org = "Org") => ({
		id,
		name: id,
		org_name: org,
		role,
	});

	it("offers a project in every workspace where the person is not an outsider", () => {
		const { projectWorkspaces } = createAccess({
			orgs: [],
			projectsBlocked: false,
			workspaces: [
				ws("a", "owner"),
				ws("b", "admin"),
				ws("c", "member"),
				ws("d", "external"),
				ws("e", "observer"),
			],
		});
		expect(projectWorkspaces.map((w) => w.id)).toEqual(["a", "b", "c"]);
		expect(projectWorkspaces[0]).toEqual({
			id: "a",
			name: "a",
			orgName: "Org",
		});
	});

	it("offers no project to an outsider everywhere, or to a user blocked from creating", () => {
		expect(
			createAccess({
				orgs: [],
				projectsBlocked: false,
				workspaces: [ws("d", "external"), ws("e", "observer")],
			}).projectWorkspaces,
		).toEqual([]);
		expect(
			createAccess({
				orgs: [],
				projectsBlocked: true,
				workspaces: [ws("a", "owner")],
			}).projectWorkspaces,
		).toEqual([]);
	});

	it("offers a workspace to an owner or admin of an organisation, not to a member", () => {
		const can = (role: string) =>
			createAccess({ orgs: [{ role }], projectsBlocked: false, workspaces: [] })
				.canCreateWorkspace;
		expect(can("owner")).toBe(true);
		expect(can("admin")).toBe(true);
		expect(can("member")).toBe(false);
		expect(
			createAccess({
				orgs: [{ role: "member" }, { role: "admin" }],
				projectsBlocked: false,
				workspaces: [],
			}).canCreateWorkspace,
		).toBe(true);
	});
});

describe("CreateMenu", () => {
	it("is the filled Create pill, and opens a menu of four with their icons", () => {
		renderMenu();
		const button = screen.getByTestId("create-menu-button");
		expect(button.textContent).toBe("Create");
		expect(button.getAttribute("data-variant")).toBe("filled");
		// Named "Create" also on a phone, where the label is hidden and the plus stays.
		expect(button.getAttribute("aria-label")).toBe("Create");
		open();
		expect(items()).toEqual([
			"Quick project",
			"Project from a template",
			"Workspace",
			"Organisation",
		]);
		for (const el of screen.getAllByRole("menuitem"))
			expect(el.querySelector("svg")).toBeTruthy();
	});

	it("shows the project items only where a project can be created, and Workspace only for an organisation admin", () => {
		renderMenu({ onWorkspace: undefined, projectWorkspaces: [] });
		open();
		expect(items()).toEqual(["Organisation"]);
	});

	it("goes straight on with the one workspace", () => {
		const h = renderMenu();
		open();
		fireEvent.click(screen.getByTestId("create-menu-quick-project"));
		expect(h.onProject).toHaveBeenCalledWith("w-team", "quick");
		expect(screen.queryByRole("dialog")).toBeNull();
		open();
		fireEvent.click(screen.getByTestId("create-menu-template-project"));
		expect(h.onProject).toHaveBeenLastCalledWith("w-team", "template");
	});

	it("asks which workspace first when there are several, the last used on top, and one press goes on", () => {
		const h = renderMenu({
			lastWorkspaceId: "w-team",
			projectWorkspaces: [team, lab, pilot],
		});
		open();
		fireEvent.click(screen.getByTestId("create-menu-template-project"));
		expect(h.onProject).not.toHaveBeenCalled();
		const dialog = screen.getByRole("dialog", {
			name: "Which workspace?",
		});
		const rows = [
			...dialog.querySelectorAll("button[data-testid^=which-workspace-]"),
		];
		expect(rows.map((r) => r.textContent)).toEqual([
			"TeamGemeente Utrecht",
			"PilotAtelier",
			"LabGemeente Utrecht",
		]);
		fireEvent.click(screen.getByTestId("which-workspace-w-lab"));
		expect(h.onProject).toHaveBeenCalledWith("w-lab", "template");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("goes nowhere when the question is closed without a choice", () => {
		const h = renderMenu({ projectWorkspaces: [team, lab] });
		open();
		fireEvent.click(screen.getByTestId("create-menu-quick-project"));
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(h.onProject).not.toHaveBeenCalled();
	});

	it("leads to the workspace wizard and the organisation dialog", () => {
		const h = renderMenu();
		open();
		fireEvent.click(screen.getByTestId("create-menu-workspace"));
		expect(h.onWorkspace).toHaveBeenCalled();
		open();
		fireEvent.click(screen.getByTestId("create-menu-organisation"));
		expect(h.onOrganisation).toHaveBeenCalled();
	});

	it("marks Organisation as not on the plan at the free cap, and still opens it", () => {
		const h = renderMenu({ orgCapped: true });
		open();
		const org = screen.getByTestId("create-menu-organisation");
		expect(org.querySelector('[data-testid="unavailable-info"]')).toBeTruthy();
		fireEvent.click(org);
		expect(h.onOrganisation).toHaveBeenCalled();
		cleanup();
		renderMenu();
		open();
		expect(
			screen
				.getByTestId("create-menu-organisation")
				.querySelector('[data-testid="unavailable-info"]'),
		).toBeNull();
	});
});

describe("CreateMenu with the project items only (workspace home)", () => {
	it("offers Quick project and Project from a template, with no divider and no question", () => {
		const onProject = renderProjectMenu();
		open();
		expect(items()).toEqual(["Quick project", "Project from a template"]);
		expect(
			screen.getByTestId("create-menu").querySelector(".mantine-Menu-divider"),
		).toBeNull();
		fireEvent.click(screen.getByTestId("create-menu-quick-project"));
		expect(onProject).toHaveBeenCalledWith("w-team", "quick");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("at the free project cap looks unavailable, says why, and opens the wall instead of the menu", () => {
		const wall = vi.fn();
		const onProject = renderProjectMenu(wall);
		const button = screen.getByTestId("create-menu-button");
		expect(button.getAttribute("aria-label")).toBe("Create");
		expect(screen.getByTestId("unavailable-info")).toBeTruthy();
		fireEvent.click(button);
		expect(wall).toHaveBeenCalledOnce();
		expect(screen.queryByRole("menuitem")).toBeNull();
		expect(onProject).not.toHaveBeenCalled();
	});
	it("takes the cap only with the project items alone, so it can hide no other item", () => {
		const props = {
			onProject: () => {},
			onProjectCap: () => {},
			projectWorkspaces: [team],
		};
		// @ts-expect-error The cap with Organisation would hide Organisation behind the wall.
		<CreateMenu {...props} onOrganisation={() => {}} />;
		// @ts-expect-error The cap with Workspace would hide Workspace behind the wall.
		<CreateMenu {...props} onWorkspace={() => {}} />;
		expect(<CreateMenu {...props} />).toBeTruthy();
	});
});

describe("the order of the workspaces", () => {
	it("puts the last used first, then sorts by organisation and name", () => {
		expect(orderWorkspaces([team, lab, pilot], null).map((w) => w.id)).toEqual([
			"w-pilot",
			"w-lab",
			"w-team",
		]);
		expect(
			orderWorkspaces([team, lab, pilot], "w-team").map((w) => w.id),
		).toEqual(["w-team", "w-pilot", "w-lab"]);
	});
});
