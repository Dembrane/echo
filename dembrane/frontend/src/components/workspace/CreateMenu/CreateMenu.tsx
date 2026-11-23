import { Trans } from "@lingui/react/macro";
import { Button, Menu } from "@mantine/core";
import {
	BuildingsIcon,
	CaretDownIcon,
	FolderOpenIcon,
	FoldersIcon,
	LightningIcon,
	PlusIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { wallPopoverLine } from "@/components/workspace/gateWalls";
import { UnavailableInfo } from "@/components/workspace/UnavailableInfo";
import {
	orderWorkspaces,
	WhichWorkspaceModal,
	type WorkspaceChoice,
} from "./WhichWorkspaceModal";

/** How a new project starts: plain (Quick start), or from the template screen. */
export type ProjectStart = "quick" | "template";

interface CreateMenuProps {
	/** Where the person can create a project. None hides the project items. */
	projectWorkspaces: readonly WorkspaceChoice[];
	/** The workspace they used last: it goes first when they are asked which. */
	lastWorkspaceId: string | null;
	/** An owner or admin of at least one organisation: shows Workspace. */
	canCreateWorkspace: boolean;
	/** The free plan's one organisation is taken: Organisation is marked, and still opens. */
	orgCapped: boolean;
	/** A project item was pressed and the workspace is known. */
	onProject: (workspaceId: string, start: ProjectStart) => void;
	onWorkspace: () => void;
	onOrganisation: () => void;
}

/**
 * "Create" (Home): the filled pill that opens a menu of what a person can create there. A
 * project goes straight to its one workspace, or asks which first when there are several.
 * Props in, callbacks out; the page decides who may create what and where it leads.
 */
export const CreateMenu = ({
	projectWorkspaces,
	lastWorkspaceId,
	canCreateWorkspace,
	orgCapped,
	onProject,
	onWorkspace,
	onOrganisation,
}: CreateMenuProps) => {
	// The start waiting for a workspace while the dialog asks which.
	const [asking, setAsking] = useState<ProjectStart | null>(null);
	const canCreateProject = projectWorkspaces.length > 0;

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
					<Button
						variant="filled"
						size="sm"
						leftSection={<PlusIcon size={20} />}
						rightSection={<CaretDownIcon size={16} aria-hidden />}
						style={{ flexShrink: 0 }}
						data-testid="create-menu-button"
					>
						{/* Own ids: the shared "Create", "Workspace" and "Organisation" read wrong as a
						    menu's words in some locales (Dutch "Maak"). */}
						<Trans id="create-menu.button">Create</Trans>
					</Button>
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
							<Menu.Divider />
						</>
					)}
					{canCreateWorkspace && (
						<Menu.Item
							leftSection={<FoldersIcon size={16} />}
							onClick={onWorkspace}
							data-testid="create-menu-workspace"
						>
							<Trans id="create-menu.workspace">Workspace</Trans>
						</Menu.Item>
					)}
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
				</Menu.Dropdown>
			</Menu>
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
		</>
	);
};
