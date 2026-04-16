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
	Select,
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
	pending_invites: Array<{ id: string; email: string; role: string; created_at: string | null }>;
	my_role: string;
	my_policies: string[];
}

async function fetchSettings(workspaceId: string): Promise<WorkspaceDetail | null> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}/settings`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

async function sendInvite(workspaceId: string, email: string, role: string, isOrgMember: boolean) {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`, {
		body: JSON.stringify({ email, is_org_member: isOrgMember, role }),
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

async function changeRole(workspaceId: string, membershipId: string, role: string) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/members/${membershipId}`,
		{
			body: JSON.stringify({ role }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to change role");
	}
}

async function updateWorkspace(workspaceId: string, payload: { name?: string; description?: string }) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/settings`,
		{
			body: JSON.stringify(payload),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to update workspace");
	}
}

async function cancelInvite(workspaceId: string, inviteId: string) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invites/${inviteId}`,
		{ credentials: "include", method: "DELETE" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to cancel invite");
	}
}

export const WorkspaceSettingsRoute = () => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState("member");
	const [editingName, setEditingName] = useState<string | null>(null);

	useDocumentTitle(t`Workspace settings | dembrane`);

	const { data: settings, isLoading } = useQuery({
		queryKey: ["v2", "workspace-settings", workspaceId],
		queryFn: () => (workspaceId ? fetchSettings(workspaceId) : null),
		enabled: !!workspaceId,
	});

	const inviteMutation = useMutation({
		mutationFn: () => {
			if (!workspaceId) throw new Error("No workspace");
			return sendInvite(workspaceId, inviteEmail.trim(), inviteRole, true);
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			setInviteEmail("");
			toast.success(data.status === "added" ? t`Member added` : t`Invite sent`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const changeRoleMutation = useMutation({
		mutationFn: ({ membershipId, role }: { membershipId: string; role: string }) => {
			if (!workspaceId) throw new Error("No workspace");
			return changeRole(workspaceId, membershipId, role);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Role updated`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const renameMutation = useMutation({
		mutationFn: (name: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return updateWorkspace(workspaceId, { name });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			setEditingName(null);
			toast.success(t`Workspace renamed`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const cancelInviteMutation = useMutation({
		mutationFn: (inviteId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return cancelInvite(workspaceId, inviteId);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Invite canceled`);
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

	const canManage = settings.my_policies?.includes("member:manage") ?? false;
	const canEditSettings = settings.my_policies?.includes("settings:manage") ?? false;

	return (
		<Container size="sm" py="xl" px="lg" pb={80}>
			<Stack gap={32}>
				{/* Header */}
				<Group justify="space-between" align="flex-start">
					<Stack gap={4} flex={1} maw={400}>
						{editingName !== null ? (
							<TextInput
								autoFocus
								size="md"
								value={editingName}
								onChange={(e) => setEditingName(e.currentTarget.value)}
								onBlur={() => {
									const trimmed = editingName.trim();
									if (trimmed && trimmed !== settings.name) {
										renameMutation.mutate(trimmed);
									} else {
										setEditingName(null);
									}
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") e.currentTarget.blur();
									if (e.key === "Escape") setEditingName(null);
								}}
								disabled={renameMutation.isPending}
								styles={{ input: { fontSize: 20, fontWeight: 400 } }}
							/>
						) : (
							<Title
								order={3}
								fw={400}
								style={{ cursor: canEditSettings ? "pointer" : "default" }}
								onClick={() => canEditSettings && setEditingName(settings.name)}
							>
								{settings.name}
							</Title>
						)}
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
							{settings.pending_invites.length > 0 &&
								` · ${settings.pending_invites.length} ${t`pending`}`}
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
						<Group gap={8} wrap="nowrap">
							<TextInput
								flex={1}
								placeholder={t`Invite by email`}
								size="sm"
								value={inviteEmail}
								onChange={(e) => setInviteEmail(e.currentTarget.value)}
							/>
							<Select
								data={[
									{ label: t`Viewer`, value: "viewer" },
									{ label: t`Member`, value: "member" },
									{ label: t`Admin`, value: "admin" },
								]}
								size="sm"
								value={inviteRole}
								w={110}
								onChange={(v) => v && setInviteRole(v)}
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
						{settings.members.map((member, idx) => (
							<Paper
								key={member.id}
								p="sm"
								withBorder
								radius={0}
								style={{
									marginTop: idx > 0 ? -1 : 0,
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
											<Text size="xs" c="dimmed" style={{ textTransform: "capitalize" }}>
												{member.source === "inherited" ? t`inherited from team` : member.source}
											</Text>
										</Box>
									</Group>

									<Group gap={8}>
										{canManage ? (
											<Select
												data={[
													{ label: t`Viewer`, value: "viewer" },
													{ label: t`Member`, value: "member" },
													{ label: t`Admin`, value: "admin" },
													{ label: t`Owner`, value: "owner" },
												]}
												size="xs"
												value={member.role}
												w={100}
												onChange={(v) => {
													if (v && v !== member.role) {
														changeRoleMutation.mutate({ membershipId: member.id, role: v });
													}
												}}
											/>
										) : (
											<Badge size="sm" variant="light" color="gray" style={{ textTransform: "capitalize" }}>
												{member.role}
											</Badge>
										)}
										{canManage && (
											<Tooltip label={t`Remove member`}>
												<ActionIcon
													color="red"
													size="sm"
													variant="subtle"
													loading={removeMutation.isPending}
													onClick={() => {
														if (confirm(`Remove ${member.display_name} from this workspace?`)) {
															removeMutation.mutate(member.id);
														}
													}}
													aria-label={t`Remove member`}
												>
													<IconTrash size={14} />
												</ActionIcon>
											</Tooltip>
										)}
									</Group>
								</Group>
							</Paper>
						))}
					</Stack>
				</Stack>

				{/* Pending invites */}
				{settings.pending_invites.length > 0 && (
					<>
						<Divider />
						<Stack gap={12}>
							<Title order={5} fw={400}>
								<Trans>Pending invites</Trans>
							</Title>
							<Stack gap={0}>
								{settings.pending_invites.map((inv) => (
									<Paper key={inv.id} p="sm" withBorder radius={0}>
										<Group justify="space-between">
											<Box>
												<Text size="sm">{inv.email}</Text>
												<Text size="xs" c="dimmed" style={{ textTransform: "capitalize" }}>
													{inv.role}
												</Text>
											</Box>
											<Group gap={8}>
												<Badge size="xs" variant="light" color="yellow">
													<Trans>Pending</Trans>
												</Badge>
												<Tooltip label={t`Cancel invite`}>
													<ActionIcon
														color="gray"
														size="sm"
														variant="subtle"
														loading={cancelInviteMutation.isPending}
														onClick={() => cancelInviteMutation.mutate(inv.id)}
														aria-label={t`Cancel invite`}
													>
														<IconX size={14} />
													</ActionIcon>
												</Tooltip>
											</Group>
										</Group>
									</Paper>
								))}
							</Stack>
						</Stack>
					</>
				)}

				{/* Your access */}
				<Divider />
				<Stack gap={12}>
					<Title order={5} fw={400}>
						<Trans>Your access</Trans>
					</Title>
					<Group gap={8}>
						<Badge size="sm" variant="light" color="blue" style={{ textTransform: "capitalize" }}>
							{settings.my_role}
						</Badge>
					</Group>
					{settings.my_policies && settings.my_policies.length > 0 && (
						<Group gap={6}>
							{settings.my_policies.map((policy) => (
								<Badge key={policy} size="xs" variant="outline" color="gray">
									{policy}
								</Badge>
							))}
						</Group>
					)}
				</Stack>
			</Stack>
		</Container>
	);
};
