import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Button,
	Collapse,
	Group,
	Paper,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconLock, IconPlus } from "@tabler/icons-react";
import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";

interface DiscoverableWorkspace {
	id: string;
	name: string;
	visibility: string;
	action: "join" | "request-access" | "pending" | "member";
	pending_request_id: string | null;
	member_count: number;
}

async function fetchDiscoverable(orgId: string): Promise<DiscoverableWorkspace[]> {
	const res = await fetch(
		`${API_BASE_URL}/v2/orgs/${orgId}/discoverable-workspaces`,
		{ credentials: "include" },
	);
	if (!res.ok) return [];
	const data = await res.json();
	return data.workspaces ?? [];
}

async function postJoin(workspaceId: string) {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}/join`, {
		method: "POST",
		credentials: "include",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Couldn't join");
	}
	return res.json();
}

async function postRequestAccess(workspaceId: string) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/access-requests`,
		{ method: "POST", credentials: "include" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Couldn't send request");
	}
	return res.json();
}

/**
 * Matrix §6 Slack-style discovery surface for the home page.
 *
 * Shows workspaces in the organisation that the user has NO direct membership
 * to (filtered server-side). Organisation admins see all with Join; organisation
 * members see open workspaces with Request access (or Pending when a
 * request is already out).
 */
export const DiscoverableWorkspaces = ({ orgId }: { orgId: string }) => {
	const queryClient = useQueryClient();
	const posthog = usePostHog();
	// Collapsed by default (2026-04-24 ask). The list can be long on
	// bigger organisations and most of the time the user isn't here to discover
	// new workspaces — they're here to enter one they already belong to.
	const [open, setOpen] = useState(false);

	const { data, isLoading } = useQuery({
		queryKey: ["v2", "discoverable-workspaces", orgId],
		queryFn: () => fetchDiscoverable(orgId),
		staleTime: 30_000,
		// Privacy toggles elsewhere don't invalidate this query on other users'
		// clients — refetch when the tab regains focus so lists catch up quickly.
		refetchOnWindowFocus: "always",
	});

	const joinable = (data ?? []).filter(
		(w) => w.action === "join" || w.action === "request-access" || w.action === "pending",
	);

	const joinMutation = useMutation({
		mutationFn: postJoin,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({
				queryKey: ["v2", "workspaces-context"],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "discoverable-workspaces", orgId],
			});
			toast.success(t`Joined`);
		},
		onError: (error: Error) => toast.error(error.message),
	});

	const requestMutation = useMutation({
		mutationFn: postRequestAccess,
		// Optimistic update: flip to "Requested" on click; rollback on error, refetch on settle.
		onMutate: async (workspaceId) => {
			const key = ["v2", "discoverable-workspaces", orgId] as const;
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData<DiscoverableWorkspace[]>(key);
			queryClient.setQueryData<DiscoverableWorkspace[]>(key, (rows) =>
				(rows ?? []).map((ws) =>
					ws.id === workspaceId
						? { ...ws, action: "pending" as const }
						: ws,
				),
			);
			return { previous };
		},
		onError: (error: Error, _workspaceId, ctx) => {
			if (ctx?.previous) {
				queryClient.setQueryData(
					["v2", "discoverable-workspaces", orgId],
					ctx.previous,
				);
			}
			toast.error(error.message);
		},
		onSuccess: (_data, workspaceId) => {
			posthog?.capture("workspace_access_requested", {
				workspace_id: workspaceId,
				org_id: orgId,
			});
			toast.success(t`Request sent`);
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "discoverable-workspaces", orgId],
			});
		},
	});

	if (isLoading || joinable.length === 0) return null;

	return (
		<Stack gap={8}>
			<UnstyledButton
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					padding: "2px 0",
				}}
			>
				<IconChevronDown
					size={14}
					style={{
						color: "var(--mantine-color-gray-6)",
						transform: open ? "rotate(0deg)" : "rotate(-90deg)",
						transition: "transform 0.15s ease",
					}}
				/>
				<Text size="xs" fw={500} c="dimmed" tt="uppercase" lts={0.5}>
					<Trans>Discoverable in this organisation</Trans>
				</Text>
				<Text size="xs" c="dimmed">
					<Plural
						value={joinable.length}
						one="(# workspace)"
						other="(# workspaces)"
					/>
				</Text>
			</UnstyledButton>
			<Collapse in={open}>
			<Stack gap={6}>
				{joinable.map((ws) => (
					<Paper
						key={ws.id}
						p="sm"
						radius="sm"
						withBorder
						style={{ background: "transparent" }}
					>
						<Group justify="space-between" wrap="nowrap">
							<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
								{ws.visibility === "private" && (
									<IconLock
										size={14}
										style={{ color: "var(--mantine-color-gray-6)" }}
									/>
								)}
								<Text size="sm" lineClamp={1}>
									{ws.name}
								</Text>
								{ws.visibility === "private" && (
									<Text size="xs" c="dimmed">
										<Trans>Private</Trans>
									</Text>
								)}
								<Text size="xs" c="dimmed">
									<Plural
										value={ws.member_count}
										one="# member"
										other="# members"
									/>
								</Text>
							</Group>
							{ws.action === "join" && (
								<Button
									size="compact-xs"
									variant="outline"
									leftSection={<IconPlus size={12} />}
									loading={
										joinMutation.isPending &&
										joinMutation.variables === ws.id
									}
									onClick={() => joinMutation.mutate(ws.id)}
								>
									<Trans>Join</Trans>
								</Button>
							)}
							{ws.action === "request-access" && (
								<Button
									size="compact-xs"
									variant="outline"
									loading={
										requestMutation.isPending &&
										requestMutation.variables === ws.id
									}
									onClick={() => requestMutation.mutate(ws.id)}
								>
									<Trans>Request access</Trans>
								</Button>
							)}
							{ws.action === "pending" && (
								<Text size="xs" c="dimmed" fs="italic">
									<Trans>Request sent</Trans>
								</Text>
							)}
						</Group>
					</Paper>
				))}
			</Stack>
			</Collapse>
		</Stack>
	);
};
