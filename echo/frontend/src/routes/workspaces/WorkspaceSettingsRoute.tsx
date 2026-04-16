import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Avatar,
	Badge,
	Box,
	Button,
	Container,
	Divider,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL, DIRECTUS_PUBLIC_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

interface WorkspaceMember {
	id: string;
	user_id: string;
	display_name: string;
	email: string;
	avatar: string | null;
	role: string;
	source: string;
	is_external: boolean;
}

interface WorkspaceDetail {
	id: string;
	name: string;
	tier: string;
	org_id: string;
	org_name: string;
	is_default: boolean;
	members: WorkspaceMember[];
	pending_invite_count: number;
}

async function fetchSettings(workspaceId: string): Promise<WorkspaceDetail | null> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}/settings`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

async function sendInvite(workspaceId: string, email: string, isOrgMember: boolean) {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`, {
		body: JSON.stringify({ email, is_org_member: isOrgMember, role: "member" }),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to send invite");
	}
	return res.json();
}

async function removeMember(workspaceId: string, membershipId: string) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/members/${membershipId}`,
		{ credentials: "include", method: "DELETE" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to remove member");
	}
}

export const WorkspaceSettingsRoute = () => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const [inviteEmail, setInviteEmail] = useState("");

	useDocumentTitle(t`Workspace settings | dembrane`);

	const { data: settings, isLoading } = useQuery({
		queryKey: ["v2", "workspace-settings", workspaceId],
		queryFn: () => (workspaceId ? fetchSettings(workspaceId) : null),
		enabled: !!workspaceId,
	});

	const inviteMutation = useMutation({
		mutationFn: () => {
			if (!workspaceId) throw new Error("No workspace");
			return sendInvite(workspaceId, inviteEmail.trim(), true);
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			setInviteEmail("");
			toast.success(data.status === "added" ? t`Member added` : t`Invite sent`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const removeMutation = useMutation({
		mutationFn: (membershipId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return removeMember(workspaceId, membershipId);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Member removed`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	if (isLoading || !settings) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	return (
		<Container size="sm" py="xl" px="lg" pb={80}>
			<Stack gap={32}>
				{/* Header */}
				<Group justify="space-between" align="flex-start">
					<Stack gap={4}>
						<Title order={3} fw={400}>
							{settings.name}
						</Title>
						<Group gap={8}>
							<Badge size="xs" variant="light" color="blue">
								{settings.tier}
							</Badge>
							<Text size="xs" c="dimmed">
								{settings.org_name}
							</Text>
						</Group>
					</Stack>
					<Button
						variant="subtle"
						size="xs"
						color="gray"
						onClick={() => navigate("/workspaces")}
					>
						<Trans>Back to workspaces</Trans>
					</Button>
				</Group>

				<Divider />

				{/* Members */}
				<Stack gap={16}>
					<Group justify="space-between">
						<Title order={5} fw={400}>
							<Trans>Members</Trans>
						</Title>
						<Text size="xs" c="dimmed">
							{settings.members.length} {settings.members.length === 1 ? t`member` : t`members`}
							{settings.pending_invite_count > 0 &&
								` · ${settings.pending_invite_count} ${t`pending`}`}
						</Text>
					</Group>

					{/* Invite */}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							const trimmed = inviteEmail.trim();
							if (!trimmed) {
								toast.error(t`Enter an email address`);
								return;
							}
							if (!trimmed.includes("@")) {
								toast.error(t`Enter a valid email address`);
								return;
							}
							inviteMutation.mutate();
						}}
					>
						<Group gap={8}>
							<TextInput
								flex={1}
								placeholder={t`Invite by email`}
								size="sm"
								value={inviteEmail}
								onChange={(e) => setInviteEmail(e.currentTarget.value)}
							/>
							<Button
								size="sm"
								leftSection={<IconPlus size={14} />}
								loading={inviteMutation.isPending}
								type="submit"
							>
								<Trans>Invite</Trans>
							</Button>
						</Group>
					</form>

					{/* Member list */}
					<Stack gap={0}>
						{settings.members.map((member) => (
							<Paper
								key={member.id}
								p="sm"
								withBorder
								radius={0}
								style={{
									borderBottom: "none",
									"&:last-child": { borderBottom: "1px solid" },
								}}
							>
								<Group justify="space-between" wrap="nowrap">
									<Group gap={12} wrap="nowrap">
										<Avatar
											size={32}
											radius="xl"
											src={member.avatar ? `${DIRECTUS_PUBLIC_URL}/assets/${member.avatar}` : null}
											color="blue"
										>
											{member.display_name?.charAt(0)?.toUpperCase()}
										</Avatar>
										<Box>
											<Group gap={6}>
												<Text size="sm" lineClamp={1}>
													{member.display_name}
												</Text>
												{member.is_external && (
													<Badge size="xs" variant="light" color="gray">
														<Trans>External</Trans>
													</Badge>
												)}
											</Group>
											<Text size="xs" c="dimmed">
												{member.role} · {member.source}
											</Text>
										</Box>
									</Group>

									<Tooltip label={t`Remove member`}>
										<ActionIcon
											color="red"
											size="sm"
											variant="subtle"
											loading={removeMutation.isPending}
											onClick={() => removeMutation.mutate(member.id)}
											aria-label={t`Remove member`}
										>
											<IconTrash size={14} />
										</ActionIcon>
									</Tooltip>
								</Group>
							</Paper>
						))}
					</Stack>
				</Stack>
			</Stack>
		</Container>
	);
};
