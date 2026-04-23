import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Avatar,
	Button,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { IconTrash, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import {
	useAddProjectShare,
	useChangeProjectShareRole,
	useProjectShares,
	useRevokeProjectShare,
	useSetProjectVisibility,
} from "@/hooks/useProjectSharing";
import { avatarUrl } from "@/lib/avatar";

interface ProjectSharingModalProps {
	projectId: string;
	opened: boolean;
	visibility: "workspace" | "private";
	workspaceName?: string;
	onClose: () => void;
}

/**
 * "Who can see this project?" modal (designer Ask 3 / W3.2).
 *
 * Verb-first labels: "can edit" / "can read". Only users already in the
 * workspace — no cross-workspace sharing (server enforces this).
 *
 * When visibility='workspace', the modal offers the Make Private action
 * with an innovator+ hint if the server rejects. When visibility='private',
 * it shows the share list + add affordance.
 */
export function ProjectSharingModal({
	projectId,
	opened,
	visibility,
	workspaceName,
	onClose,
}: ProjectSharingModalProps) {
	const { data: shares, isLoading } = useProjectShares(projectId);
	const addShare = useAddProjectShare(projectId);
	const changeRole = useChangeProjectShareRole(projectId);
	const revoke = useRevokeProjectShare(projectId);
	const setVisibility = useSetProjectVisibility(projectId);

	const [newEmail, setNewEmail] = useState("");
	const [newRole, setNewRole] = useState<"viewer" | "editor">("viewer");

	const handleAdd = async () => {
		const email = newEmail.trim();
		if (!email) return;
		try {
			await addShare.mutateAsync({ email, role: newRole });
			setNewEmail("");
			setNewRole("viewer");
			toast.success(t`Added`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t`Couldn't add person`);
		}
	};

	const handleMakePrivate = async () => {
		try {
			await setVisibility.mutateAsync("private");
			// Designer's Q3 recommendation: confirm the state + point at
			// the next action without preaching.
			toast.success(t`Private. Add people to share it.`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : t`Couldn't change visibility`;
			toast.error(msg);
		}
	};

	const handleMakeOpen = async () => {
		try {
			await setVisibility.mutateAsync("workspace");
			toast.success(
				workspaceName
					? t`Project is now visible to everyone in ${workspaceName}`
					: t`Project is now visible to the workspace`,
			);
			onClose();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : t`Couldn't change visibility`,
			);
		}
	};

	const title = (
		<Text size="lg" fw={500}>
			<Trans>Who can see this project?</Trans>
		</Text>
	);

	if (visibility === "workspace") {
		return (
			<Modal
				opened={opened}
				onClose={onClose}
				title={title}
				centered
				size="md"
			>
				<Stack gap="md">
					<Alert color="gray" variant="light">
						<Text size="sm">
							{workspaceName ? (
								<Trans>
									This project is visible to everyone in {workspaceName}.
								</Trans>
							) : (
								<Trans>
									This project is visible to everyone in the workspace.
								</Trans>
							)}
						</Text>
						<Text size="xs" c="dimmed" mt={4}>
							<Trans>
								Make it private to share with specific people only. Private
								projects require the innovator plan or above.
							</Trans>
						</Text>
					</Alert>
					<Group justify="flex-end">
						<Button variant="default" onClick={onClose}>
							<Trans>Close</Trans>
						</Button>
						<Button
							loading={setVisibility.isPending}
							onClick={handleMakePrivate}
						>
							<Trans>Make private</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
		);
	}

	return (
		<Modal opened={opened} onClose={onClose} title={title} centered size="md">
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					<Trans>
						Only people already in this workspace can be added. Invite them to
						the workspace first if they aren't here yet.
					</Trans>
				</Text>

				{/* Current shares */}
				<Stack gap="xs">
					{isLoading && <Text size="sm">…</Text>}
					{!isLoading && (shares?.length ?? 0) === 0 && (
						<Text size="sm" c="dimmed">
							<Trans>Just you, for now.</Trans>
						</Text>
					)}
					{shares?.map((share) => (
						<Group key={share.user_id} gap="sm" wrap="nowrap">
							<Avatar size="sm" radius="xl" src={avatarUrl(share.avatar, 48)}>
								{(share.display_name || share.email || "?")
									.slice(0, 2)
									.toUpperCase()}
							</Avatar>
							<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
								<Text size="sm" truncate>
									{share.display_name || share.email || t`Unknown`}
								</Text>
								{/* Email always shown next to the name when we got one
								    back — the server already redacts for non-managers
								    of private projects. */}
								{share.email && share.email !== share.display_name && (
									<Text size="xs" c="dimmed" truncate>
										{share.email}
									</Text>
								)}
							</Stack>
							<Select
								data={[
									{ value: "viewer", label: t`can read` },
									{ value: "editor", label: t`can edit` },
								]}
								value={share.role}
								onChange={(val) => {
									if (!val) return;
									changeRole
										.mutateAsync({
											userId: share.user_id,
											role: val as "viewer" | "editor",
										})
										.catch((err: Error) => toast.error(err.message));
								}}
								size="xs"
								w={110}
							/>
							<ActionIcon
								variant="subtle"
								color="gray"
								size="sm"
								onClick={() => {
									revoke
										.mutateAsync(share.user_id)
										.catch((err: Error) => toast.error(err.message));
								}}
							>
								<IconTrash size={14} />
							</ActionIcon>
						</Group>
					))}
				</Stack>

				{/* Add form */}
				<Group gap="xs" wrap="nowrap" align="flex-end">
					<TextInput
						flex={1}
						label={t`Add by email`}
						placeholder="name@example.com"
						value={newEmail}
						onChange={(e) => setNewEmail(e.currentTarget.value)}
						size="sm"
					/>
					<Select
						label={t`Role`}
						data={[
							{ value: "viewer", label: t`can read` },
							{ value: "editor", label: t`can edit` },
						]}
						value={newRole}
						onChange={(val) => {
							if (val) setNewRole(val as "viewer" | "editor");
						}}
						size="sm"
						w={120}
					/>
					<Button
						size="sm"
						loading={addShare.isPending}
						onClick={handleAdd}
						disabled={!newEmail.trim()}
					>
						<Trans>Add</Trans>
					</Button>
				</Group>

				{/* Footer: flip back to public */}
				<Group justify="space-between" mt="md">
					<Button
						variant="subtle"
						color="gray"
						size="sm"
						onClick={handleMakeOpen}
						loading={setVisibility.isPending}
					>
						<Trans>Make visible to the whole workspace</Trans>
					</Button>
					<Button variant="default" size="sm" onClick={onClose}>
						<Trans>Done</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
