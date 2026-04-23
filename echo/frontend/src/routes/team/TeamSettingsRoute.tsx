import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Center,
	Container,
	Group,
	Loader,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

/**
 * Team settings page — name and logo for now. Lives at /t/:teamId/settings.
 * Wires to PATCH /v2/orgs/:id which already enforces admin/owner role
 * and URL-scheme validation on logo_url.
 *
 * Future: whitelabel defaults cascade to workspaces — noted but scoped out.
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
	body: { name?: string; logo_url?: string },
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

	const [name, setName] = useState<string | null>(null);
	const [logoUrl, setLogoUrl] = useState<string | null>(null);

	const updateMutation = useMutation({
		mutationFn: (body: { name?: string; logo_url?: string }) =>
			updateTeam(teamId as string, body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "team", teamId] });
			queryClient.invalidateQueries({ queryKey: ["v2", "orgs"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			toast.success(t`Saved`);
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
	const effectiveName = name ?? team.name;
	const effectiveLogo = logoUrl ?? team.logo_url ?? "";
	const dirty =
		(name !== null && name.trim() !== team.name) ||
		(logoUrl !== null && logoUrl.trim() !== (team.logo_url ?? ""));

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
						<Trans>
							Only team admins can change team settings.
						</Trans>
					</Alert>
				)}

				<Stack gap="md">
					<TextInput
						label={t`Team name`}
						description={t`Shown on the workspace selector and in email subject lines.`}
						value={effectiveName}
						disabled={!canEdit}
						onChange={(e) => setName(e.currentTarget.value)}
						maxLength={100}
					/>
					<TextInput
						label={t`Logo URL`}
						description={t`Absolute https URL to a small logo. Workspace-level logo takes precedence when set.`}
						placeholder="https://..."
						value={effectiveLogo}
						disabled={!canEdit}
						onChange={(e) => setLogoUrl(e.currentTarget.value)}
						maxLength={2048}
					/>
					{canEdit && (
						<Group justify="flex-end">
							<Button
								variant="default"
								onClick={() => {
									setName(null);
									setLogoUrl(null);
								}}
								disabled={!dirty}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								loading={updateMutation.isPending}
								disabled={!dirty}
								onClick={() => {
									const payload: { name?: string; logo_url?: string } = {};
									if (name !== null && name.trim() !== team.name) {
										payload.name = name.trim();
									}
									if (
										logoUrl !== null &&
										logoUrl.trim() !== (team.logo_url ?? "")
									) {
										payload.logo_url = logoUrl.trim();
									}
									updateMutation.mutate(payload);
								}}
							>
								<Trans>Save</Trans>
							</Button>
						</Group>
					)}
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
