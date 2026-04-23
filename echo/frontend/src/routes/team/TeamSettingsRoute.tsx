import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Center,
	Container,
	FileButton,
	Group,
	Image,
	Loader,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { IconTrash, IconUpload } from "@tabler/icons-react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { logoUrl as resolveLogoUrl } from "@/lib/avatar";

/**
 * Team settings page — name and logo. Logo upload mirrors the
 * workspace-logo flow (FileButton → POST multipart; URL resolution via
 * logoUrl() helper so legacy http(s) values still render).
 */

interface TeamDetail {
	id: string;
	name: string;
	logo_url: string | null;
	role: string;
	member_count: number;
	workspace_count: number;
	external_count: number;
}

async function fetchTeam(teamId: string): Promise<TeamDetail | null> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

async function updateTeam(
	teamId: string,
	body: { name?: string },
): Promise<TeamDetail> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}`, {
		body: JSON.stringify(body),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "PATCH",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Couldn't save");
	}
	return res.json();
}

async function uploadTeamLogo(teamId: string, file: Blob, filename = "logo.png") {
	const body = new FormData();
	body.append("file", file, filename);
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}/logo`, {
		method: "POST",
		credentials: "include",
		body,
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Failed to upload logo",
		);
	}
	const data = await res.json();
	return data.file_id as string;
}

async function removeTeamLogo(teamId: string) {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}/logo`, {
		method: "DELETE",
		credentials: "include",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Failed to remove logo",
		);
	}
}

export const TeamSettingsRoute = () => {
	const { teamId } = useParams();
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();

	useDocumentTitle(t`Team settings | dembrane`);

	const { data: team, isLoading } = useQuery({
		queryKey: ["v2", "team", teamId],
		queryFn: () => fetchTeam(teamId as string),
		enabled: Boolean(teamId),
	});

	// Autosave name on blur; logo commits immediately on upload/remove.
	// Matches the inline-edit pattern used elsewhere (HostGuide).
	const [name, setName] = useState<string>("");
	const logoResetRef = useRef<() => void>(null);

	// Seed local state once team loads (or when the team id changes).
	useEffect(() => {
		if (team) setName(team.name);
	}, [team?.id, team?.name]);

	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: ["v2", "team", teamId] });
		queryClient.invalidateQueries({ queryKey: ["v2", "orgs"] });
		queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
	};

	const updateMutation = useMutation({
		mutationFn: (body: { name?: string }) =>
			updateTeam(teamId as string, body),
		onSuccess: () => {
			invalidate();
			toast.success(t`Saved`);
		},
		onError: (err: Error) => {
			// Roll back the visible value so the field can't drift from DB.
			if (team) setName(team.name);
			toast.error(err.message);
		},
	});
	const uploadLogoMutation = useMutation({
		mutationFn: (file: File) =>
			uploadTeamLogo(teamId as string, file, file.name || "logo.png"),
		onSuccess: () => {
			invalidate();
			toast.success(t`Logo updated`);
		},
		onError: (err: Error) => toast.error(err.message),
	});
	const removeLogoMutation = useMutation({
		mutationFn: () => removeTeamLogo(teamId as string),
		onSuccess: () => {
			invalidate();
			toast.success(t`Logo removed`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	if (isLoading) {
		return (
			<Center style={{ height: "60vh" }}>
				<Loader size="sm" color="gray" />
			</Center>
		);
	}

	if (!team) {
		return (
			<Center style={{ height: "60vh" }}>
				<Stack align="center">
					<Title order={3} fw={400}>
						<Trans>Team not found</Trans>
					</Title>
					<Button variant="default" onClick={() => navigate("/w")}>
						<Trans>Back</Trans>
					</Button>
				</Stack>
			</Center>
		);
	}

	const canEdit = team.role === "owner" || team.role === "admin";
	const currentLogoUrl = resolveLogoUrl(team.logo_url);

	const handleLogoSelect = (file: File | null) => {
		logoResetRef.current?.();
		if (!file) return;
		uploadLogoMutation.mutate(file);
	};

	return (
		<Container size="sm" py="xl" px="lg">
			<Stack gap="xl">
				<Stack gap={4}>
					<Title order={3} fw={400}>
						<Trans>Team settings</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							Update your team's name and branding. Workspace-level settings
							live on each workspace's own settings page.
						</Trans>
					</Text>
				</Stack>

				{!canEdit && (
					<Alert color="gray" variant="light">
						<Trans>Only team admins can change team settings.</Trans>
					</Alert>
				)}

				<Stack gap="md">
					<TextInput
						label={t`Team name`}
						description={t`Shown in the team header and in email subject lines.`}
						value={name}
						disabled={!canEdit || updateMutation.isPending}
						onChange={(e) => setName(e.currentTarget.value)}
						onBlur={() => {
							const next = name.trim();
							if (next && next !== team.name) {
								updateMutation.mutate({ name: next });
							} else if (!next) {
								setName(team.name);
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
							if (e.key === "Escape") {
								setName(team.name);
								(e.currentTarget as HTMLInputElement).blur();
							}
						}}
						maxLength={100}
					/>

					<Stack gap={6}>
						<Text size="sm" fw={500}>
							<Trans>Logo</Trans>
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>
								Workspace-level logo takes precedence when set.
							</Trans>
						</Text>
						{currentLogoUrl ? (
							<Group gap="sm" align="center">
								<Image
									src={currentLogoUrl}
									alt={t`Team logo`}
									h={48}
									w="auto"
									fit="contain"
									style={{ maxWidth: 200 }}
								/>
								<Button
									variant="subtle"
									color="red"
									size="compact-sm"
									leftSection={<IconTrash size={14} />}
									loading={removeLogoMutation.isPending}
									disabled={!canEdit}
									onClick={() => removeLogoMutation.mutate()}
								>
									<Trans>Remove</Trans>
								</Button>
							</Group>
						) : (
							<Text size="xs" c="dimmed" fs="italic">
								<Trans>No logo set — dembrane default will be used.</Trans>
							</Text>
						)}
						<FileButton
							resetRef={logoResetRef}
							onChange={handleLogoSelect}
							accept="image/png,image/jpeg,image/svg+xml,image/webp"
							disabled={!canEdit}
						>
							{(props) => (
								<Button
									variant="light"
									size="compact-sm"
									leftSection={<IconUpload size={14} />}
									loading={uploadLogoMutation.isPending}
									style={{ alignSelf: "flex-start" }}
									{...props}
								>
									{currentLogoUrl ? (
										<Trans>Replace logo</Trans>
									) : (
										<Trans>Upload logo</Trans>
									)}
								</Button>
							)}
						</FileButton>
					</Stack>

				</Stack>

				<Button
					variant="subtle"
					size="sm"
					onClick={() => navigate(`/t/${teamId}`)}
				>
					<Trans>← Back to team</Trans>
				</Button>
			</Stack>
		</Container>
	);
};

export default TeamSettingsRoute;
