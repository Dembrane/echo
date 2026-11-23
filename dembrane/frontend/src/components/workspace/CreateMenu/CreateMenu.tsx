import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, type ButtonProps, Group, Menu } from "@mantine/core";
import {
	BuildingsIcon,
	CaretDownIcon,
	FolderOpenIcon,
	FoldersIcon,
	LightningIcon,
	PlusIcon,
} from "@phosphor-icons/react";
import { forwardRef, useState } from "react";
import { wallPopoverLine } from "@/components/workspace/gateWalls";
import { UnavailableInfo } from "@/components/workspace/UnavailableInfo";
import classes from "./CreateMenu.module.css";
import {
	orderWorkspaces,
	WhichWorkspaceModal,
	type WorkspaceChoice,
} from "./WhichWorkspaceModal";

/** How a new project starts: plain (Quick start), or from the template screen. */
export type ProjectStart = "quick" | "template";

interface CreateMenuBase {
	/** Where the person can create a project. None hides the project items. */
	projectWorkspaces: readonly WorkspaceChoice[];
	/** The workspace they used last: it goes first when they are asked which. */
	lastWorkspaceId?: string | null;
	/** A project item was pressed and the workspace is known. */
	onProject: (workspaceId: string, start: ProjectStart) => void;
}

/**
 * Either the full menu (Home), or the project items only (workspace home), which alone
 * can carry the free project cap: at the cap the whole button opens the wall, so it may
 * not hide a Workspace or Organisation item. The types hold that.
 */
type CreateMenuProps = CreateMenuBase &
	(
		| {
				/** Shows Workspace. Left out, the menu has no Workspace item. */
				onWorkspace?: () => void;
				/** Shows Organisation. Left out, the menu has no Organisation item. */
				onOrganisation?: () => void;
				/** The free plan's one organisation is taken: Organisation is marked, and still opens. */
				orgCapped?: boolean;
				onProjectCap?: undefined;
		  }
		| {
				onWorkspace?: undefined;
				onOrganisation?: undefined;
				orgCapped?: undefined;
				/**
				 * Given only at the free project cap: the button looks unavailable with the
				 * reason beside it, and a press calls this (the page's upgrade wall) instead
				 * of the menu. Only with the project items alone.
				 */
				onProjectCap?: () => void;
		  }
	);

/**
 * The filled Create pill, with a caret, or a plus alone on a phone (CreateMenu.module.css).
 * The accessible name stays "Create" in both shapes.
 */
const CreateButton = forwardRef<
	HTMLButtonElement,
	ButtonProps & { onClick?: () => void; caret?: boolean }
>(({ caret = true, ...props }, ref) => (
	<Button
		ref={ref}
		variant="filled"
		size="sm"
		leftSection={<PlusIcon size={20} aria-hidden />}
		rightSection={caret ? <CaretDownIcon size={16} aria-hidden /> : undefined}
		classNames={{
			label: classes.label,
			root: classes.button,
			section: classes.section,
		}}
		style={{ flexShrink: 0 }}
		aria-label={t({ id: "create-menu.button", message: "Create" })}
		data-testid="create-menu-button"
		{...props}
	>
		{/* Own ids: the shared "Create", "Workspace" and "Organisation" read wrong as a
		    menu's words in some locales (Dutch "Maak"). */}
		<Trans id="create-menu.button">Create</Trans>
	</Button>
));

/**
 * "Create": the filled pill that opens a menu of what a person can create there. Home
 * offers everything; workspace home gives no onWorkspace or onOrganisation and one
 * workspace, so it shows the two project items only. A project goes straight to its one
 * workspace, or asks which first when there are several. Props in, callbacks out; the
 * page decides who may create what and where it leads.
 */
export const CreateMenu = ({
	projectWorkspaces,
	lastWorkspaceId = null,
	onProject,
	onWorkspace,
	onOrganisation,
	orgCapped = false,
	onProjectCap,
}: CreateMenuProps) => {
	// The start waiting for a workspace while the dialog asks which.
	const [asking, setAsking] = useState<ProjectStart | null>(null);
	const canCreateProject = projectWorkspaces.length > 0;

	if (onProjectCap) {
		// The press opens the wall where it is, as the old Create project button did.
		return (
			<Group gap={4} wrap="nowrap">
				<CreateButton caret={false} opacity={0.8} onClick={onProjectCap} />
				<UnavailableInfo label={wallPopoverLine("project_cap")} />
			</Group>
		);
	}

	const startProject = (start: ProjectStart) => {
		const only = projectWorkspaces.length === 1 ? projectWorkspaces[0] : null;
		if (only) onProject(only.id, start);
		else setAsking(start);
	};

	return (
		<>
			{/* As wide as its longest item, so no label wraps in any language. */}
			<Menu position="bottom-end">
				<Menu.Target>
					<CreateButton />
				</Menu.Target>
				<Menu.Dropdown data-testid="create-menu">
					{canCreateProject && (
						<>
							<Menu.Item
								leftSection={<LightningIcon size={16} />}
								onClick={() => startProject("quick")}
								data-testid="create-menu-quick-project"
							>
								<Trans>Quick project</Trans>
							</Menu.Item>
							<Menu.Item
								leftSection={<FolderOpenIcon size={16} />}
								onClick={() => startProject("template")}
								data-testid="create-menu-template-project"
							>
								<Trans>Project from a template</Trans>
							</Menu.Item>
							{(onWorkspace || onOrganisation) && <Menu.Divider />}
						</>
					)}
					{onWorkspace && (
						<Menu.Item
							leftSection={<FoldersIcon size={16} />}
							onClick={onWorkspace}
							data-testid="create-menu-workspace"
						>
							<Trans id="create-menu.workspace">Workspace</Trans>
						</Menu.Item>
					)}
					{onOrganisation && (
						<Menu.Item
							leftSection={<BuildingsIcon size={16} />}
							rightSection={
								orgCapped ? (
									<UnavailableInfo label={wallPopoverLine("org_cap")} />
								) : undefined
							}
							opacity={orgCapped ? 0.8 : 1}
							onClick={onOrganisation}
							data-testid="create-menu-organisation"
						>
							<Trans id="create-menu.organisation">Organisation</Trans>
						</Menu.Item>
					)}
				</Menu.Dropdown>
			</Menu>
			{projectWorkspaces.length > 1 && (
				<WhichWorkspaceModal
					opened={asking !== null}
					onClose={() => setAsking(null)}
					workspaces={orderWorkspaces(projectWorkspaces, lastWorkspaceId)}
					onChoose={(id) => {
						const start = asking;
						setAsking(null);
						if (start) onProject(id, start);
					}}
				/>
			)}
		</>
	);
};
