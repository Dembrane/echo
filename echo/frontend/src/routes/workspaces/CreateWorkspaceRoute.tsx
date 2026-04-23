import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Center,
	Container,
	Group,
	Loader,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";

async function createWorkspace(payload: {
	name: string;
	org_id?: string;
	inherit_team_admins?: boolean;
	inherit_team_members?: boolean;
}) {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		body: JSON.stringify(payload),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to create workspace");
	}
	return res.json();
}

/**
 * Create-workspace form. Entered from the dashed "+ Add workspace" card
 * on the selector, which passes `?teamId=<org>` so the form knows which
 * team to create into. Without teamId the form falls back to the user's
 * primary admin team and asks them to confirm.
 *
 * Pre-checks before rendering the form:
 *   - Not onboarded → redirect to /onboarding. Matches the user's ask:
 *     "don't dump 'No team found. Complete onboarding first.' as an
 *     error — route me there first."
 *   - Onboarded but admin/owner on no team → render a friendly "Ask
 *     your team admin" state. Members genuinely can't create workspaces.
 */
export const CreateWorkspaceRoute = () => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const { setWorkspace } = useWorkspace();
	const [searchParams] = useSearchParams();
	const teamIdFromQuery = searchParams.get("teamId") ?? null;
	const { data: meV2, isLoading: meLoading } = useV2Me();
	const [name, setName] = useState("");
	const [privacy, setPrivacy] = useState<"open" | "private">("open");
	const [includeMembers, setIncludeMembers] = useState(false);

	useDocumentTitle(t`New workspace | dembrane`);

	// Teams where the caller has permission to create workspaces.
	const adminTeams = useMemo(
		() =>
			(meV2?.orgs ?? []).filter(
				(o) => o.role === "owner" || o.role === "admin",
			),
		[meV2],
	);

	// Redirect unonboarded users to onboarding instead of showing a 403.
	useEffect(() => {
		if (meLoading) return;
		if (meV2 && meV2.onboarding_completed === false) {
			navigate("/onboarding");
		}
	}, [meLoading, meV2, navigate]);

	const targetTeamId = teamIdFromQuery || adminTeams[0]?.id || null;
	const targetTeam = adminTeams.find((o) => o.id === targetTeamId) ?? null;

	const mutation = useMutation({
		mutationFn: () =>
			createWorkspace({
				name: name.trim(),
				org_id: targetTeamId ?? undefined,
				inherit_team_admins: privacy === "open",
				inherit_team_members: privacy === "open" ? includeMembers : false,
			}),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "team"] });
			setWorkspace(data.id);
			toast.success(t`Workspace created`);
			navigate(`/w/${data.id}/projects`);
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	if (meLoading || meV2?.onboarding_completed === false) {
		return (
			<Center style={{ height: "60vh" }}>
				<Loader size="sm" color="gray" />
			</Center>
		);
	}

	// Onboarded, but not admin on any team. The backend would 403 —
	// tell the user what's actually wrong instead of error-toasting.
	if (adminTeams.length === 0) {
		return (
			<Container size="xs" py="xl" px="lg">
				<Stack gap="md">
					<Title order={3} fw={400}>
						<Trans>You can't create a workspace yet</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							Only team admins and owners can create workspaces. Ask an admin
							on your team to create one, or ask them to promote you first.
						</Trans>
					</Text>
					<Group>
						<Button variant="default" onClick={() => navigate("/w")}>
							<Trans>Back</Trans>
						</Button>
					</Group>
				</Stack>
			</Container>
		);
	}

	return (
		<Container size="xs" py="xl" px="lg">
			<Stack gap={32}>
				<Stack gap={8}>
					<Title order={3} fw={400}>
						<Trans>New workspace</Trans>
					</Title>
					{targetTeam && (
						<Text size="sm" c="dimmed">
							<Trans>
								Creating in <em>{targetTeam.name}</em>
							</Trans>
						</Text>
					)}
					<Text size="sm" c="dimmed">
						<Trans>
							Workspaces hold projects for a specific client or purpose.
						</Trans>
					</Text>
				</Stack>

				{teamIdFromQuery && !targetTeam && (
					<Alert color="gray" variant="light">
						<Trans>
							You don't have permission to create workspaces in that team.
							Falling back to your primary team instead.
						</Trans>
					</Alert>
				)}

				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (!name.trim()) return;
						mutation.mutate();
					}}
				>
					<Stack gap={16}>
						<TextInput
							autoFocus
							label={t`Workspace name`}
							placeholder={t`e.g. Client Alpha, Q1 Research`}
							size="sm"
							value={name}
							onChange={(e) => setName(e.currentTarget.value)}
						/>

						{/* Team picker only shows when the user has multiple admin
						    teams and no ?teamId was supplied. Keeps the common
						    single-team path friction-free. */}
						{!teamIdFromQuery && adminTeams.length > 1 && (
							<Select
								label={t`Team`}
								description={t`Which team does this workspace belong to?`}
								data={adminTeams.map((o) => ({
									value: o.id,
									label: o.name,
								}))}
								value={targetTeamId}
								onChange={(v) => {
									if (v)
										navigate(`/w/new?teamId=${v}`, { replace: true });
								}}
								size="sm"
							/>
						)}

						<Select
							label={t`Access`}
							description={t`Private workspaces require innovator tier or above.`}
							data={[
								{
									value: "open",
									label: t`Open — team admins get access automatically`,
								},
								{
									value: "private",
									label: t`Private — only people you invite`,
								},
							]}
							value={privacy}
							onChange={(v) => v && setPrivacy(v as "open" | "private")}
							size="sm"
						/>

						{/* Matrix §6 honesty disclosure. Private protects from team
						    members, not team admins. Surface it so the creator isn't
						    surprised later. */}
						{privacy === "private" && (
							<Text size="xs" c="dimmed" ml="xs">
								<Trans>
									Team admins can still discover and join this workspace.
								</Trans>
							</Text>
						)}

						{privacy === "open" && (
							<Group gap="xs" align="flex-start" ml="xs">
								<input
									type="checkbox"
									id="create-include-members"
									checked={includeMembers}
									onChange={(e) =>
										setIncludeMembers(e.currentTarget.checked)
									}
									style={{ marginTop: 2 }}
								/>
								<Text
									component="label"
									htmlFor="create-include-members"
									size="xs"
									c="dimmed"
								>
									<Trans>Also give team members access (not just admins)</Trans>
								</Text>
							</Group>
						)}

						<Group gap={12} mt={8}>
							<Button size="sm" variant="default" onClick={() => navigate("/w")}>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								flex={1}
								loading={mutation.isPending}
								disabled={!name.trim() || !targetTeamId}
								size="sm"
								type="submit"
							>
								<Trans>Create workspace</Trans>
							</Button>
						</Group>
					</Stack>
				</form>
			</Stack>
		</Container>
	);
};
