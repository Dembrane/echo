import { t } from "@lingui/core/macro";
import { Modal, Stack } from "@mantine/core";
import { FoldersIcon } from "@phosphor-icons/react";
import classes from "@/components/common/ResultRow/ResultRow.module.css";

/** A workspace a project can go in, as the dialog shows it. */
export interface WorkspaceChoice {
	id: string;
	name: string;
	orgName: string;
}

/**
 * The workspace used last first, then by organisation and by name, so the likely one is
 * on top and the rest are where the eye looks for them.
 */
export const orderWorkspaces = (
	list: readonly WorkspaceChoice[],
	lastId: string | null,
): WorkspaceChoice[] =>
	[...list].sort(
		(a, b) =>
			Number(b.id === lastId) - Number(a.id === lastId) ||
			a.orgName.localeCompare(b.orgName) ||
			a.name.localeCompare(b.name),
	);

interface WhichWorkspaceModalProps {
	opened: boolean;
	onClose: () => void;
	/** In the order to show them. */
	workspaces: readonly WorkspaceChoice[];
	/** One press on a row goes on: there is no Continue. */
	onChoose: (workspaceId: string) => void;
}

/**
 * "Which workspace?", asked once when a person can create a project in more than one. One
 * row per workspace, as Home's search results draw a workspace: its icon, its name and its
 * organisation under it. Props in, callbacks out.
 */
export const WhichWorkspaceModal = ({
	opened,
	onClose,
	workspaces,
	onChoose,
}: WhichWorkspaceModalProps) => (
	<Modal
		opened={opened}
		onClose={onClose}
		title={t`Which workspace?`}
		data-testid="which-workspace-modal"
	>
		<Stack gap={8}>
			{workspaces.map((ws) => (
				<button
					type="button"
					key={ws.id}
					onClick={() => onChoose(ws.id)}
					className={`app-do ${classes.resultRow}`}
					data-testid={`which-workspace-${ws.id}`}
				>
					<FoldersIcon size={20} className={classes.resultIcon} aria-hidden />
					<span className={classes.resultLabel}>
						<span className={classes.resultTitle}>{ws.name}</span>
						<span className={classes.resultSubtitle}>{ws.orgName}</span>
					</span>
				</button>
			))}
		</Stack>
	</Modal>
);
