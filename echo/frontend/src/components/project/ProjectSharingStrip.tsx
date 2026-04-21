import { Trans } from "@lingui/react/macro";
import {
	Avatar,
	Badge,
	Button,
	Group,
	Loader,
	Text,
} from "@mantine/core";
import { IconLock, IconUsers } from "@tabler/icons-react";
import { useState } from "react";
import { useProjectShares } from "@/hooks/useProjectSharing";
import { ProjectSharingModal } from "./ProjectSharingModal";

interface ProjectSharingStripProps {
	projectId: string;
	visibility: "workspace" | "private";
	workspaceName?: string;
}

/**
 * Persistent "Shared with" strip on the project overview (designer Ask 3 / W3).
 *
 * Two resting states:
 *   - visibility='workspace': "Visible to everyone in [workspace] · Make private"
 *     Framing is intentional — public is the default, private is the action.
 *   - visibility='private':    "[Private pill] Shared with [avatars] +N more · Manage"
 *
 * Clicking Manage opens the share modal. Making a project private is
 * innovator+ gated server-side; UI shows the upgrade path via the modal.
 */
export function ProjectSharingStrip({
	projectId,
	visibility,
	workspaceName,
}: ProjectSharingStripProps) {
	const [modalOpen, setModalOpen] = useState(false);
	const { data: shares, isLoading } = useProjectShares(projectId);

	const isPrivate = visibility === "private";
	const shareCount = shares?.length ?? 0;

	return (
		<>
			<Group
				gap="sm"
				wrap="nowrap"
				px="md"
				py="sm"
				style={{
					backgroundColor: "var(--mantine-color-gray-0)",
					border: "1px solid var(--mantine-color-gray-2)",
					borderRadius: 6,
				}}
			>
				{isPrivate ? (
					<>
						<Badge
							color="blue"
							variant="light"
							leftSection={<IconLock size={12} />}
						>
							<Trans>Private</Trans>
						</Badge>
						{isLoading ? (
							<Loader size="xs" />
						) : shareCount === 0 ? (
							<Text size="sm" c="dimmed">
								<Trans>Just you. Share with specific people →</Trans>
							</Text>
						) : (
							<>
								<Text size="sm" c="dimmed">
									<Trans>Shared with</Trans>
								</Text>
								<Avatar.Group spacing="xs">
									{shares?.slice(0, 3).map((s) => (
										<Avatar
											key={s.user_id}
											size="sm"
											radius="xl"
											src={s.avatar ?? undefined}
										>
											{(s.display_name || s.email)
												.slice(0, 2)
												.toUpperCase()}
										</Avatar>
									))}
								</Avatar.Group>
								{shareCount > 3 && (
									<Text size="sm" c="dimmed">
										<Trans>+{shareCount - 3} more</Trans>
									</Text>
								)}
							</>
						)}
						<Button
							variant="subtle"
							size="compact-sm"
							ml="auto"
							onClick={() => setModalOpen(true)}
						>
							<Trans>Manage</Trans>
						</Button>
					</>
				) : (
					<>
						<IconUsers
							size={16}
							style={{ color: "var(--mantine-color-gray-6)" }}
						/>
						<Text size="sm">
							{workspaceName ? (
								<Trans>Visible to everyone in {workspaceName}</Trans>
							) : (
								<Trans>Visible to everyone in this workspace</Trans>
							)}
						</Text>
						<Button
							variant="subtle"
							size="compact-sm"
							ml="auto"
							onClick={() => setModalOpen(true)}
						>
							<Trans>Make private</Trans>
						</Button>
					</>
				)}
			</Group>

			<ProjectSharingModal
				projectId={projectId}
				opened={modalOpen}
				visibility={visibility}
				workspaceName={workspaceName}
				onClose={() => setModalOpen(false)}
			/>
		</>
	);
}
