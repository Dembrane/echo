import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Button,
	Checkbox,
	Collapse,
	Group,
	Paper,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { usePostHog } from "@posthog/react";
import { IconChevronDown, IconLock } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
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

async function fetchDiscoverable(
	orgId: string,
): Promise<DiscoverableWorkspace[]> {
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
		credentials: "include",
		method: "POST",
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
		{ credentials: "include", method: "POST" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Couldn't send request");
	}
	return res.json();
}

/**
 * Matrix §6 discovery surface for the organisation home.
 *
 * Lists workspaces the user has NO direct membership to (filtered server-side).
 * Organisation admins get `join` rows for the org's private workspaces: they pick
 * one or several and add themselves as admin in a single confirmed action (members
 * are never auto-added to each other's workspaces). Organisation members get
 * `request-access` / `pending` rows for open workspaces.
 */
export const DiscoverableWorkspaces = ({ orgId }: { orgId: string }) => {
	const queryClient = useQueryClient();
	const posthog = usePostHog();
	// Collapsed by default: the list can be long and most visits are to enter a
	// workspace you already belong to, not to discover new ones.
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [confirmOpened, confirm] = useDisclosure(false);

	const { data, isLoading } = useQuery({
		queryFn: () => fetchDiscoverable(orgId),
		queryKey: ["v2", "discoverable-workspaces", orgId],
		refetchOnWindowFocus: "always",
		staleTime: 30_000,
	});

	const joinable = (data ?? []).filter(
		(w) =>
			w.action === "join" ||
			w.action === "request-access" ||
			w.action === "pending",
	);
	// Admin self-join rows (private workspaces) vs member request-access rows.
	const joinRows = useMemo(
		() => joinable.filter((w) => w.action === "join"),
		[joinable],
	);
	const otherRows = useMemo(
		() => joinable.filter((w) => w.action !== "join"),
		[joinable],
	);
	// Selection scoped to the rows currently available (drop stale ids).
	const selectedIds = useMemo(
		() => joinRows.filter((w) => selected.has(w.id)).map((w) => w.id),
		[joinRows, selected],
	);
	const allSelected = joinRows.length > 0 && selectedIds.length === joinRows.length;
	const someSelected = selectedIds.length > 0 && !allSelected;

	const toggle = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const toggleAll = () =>
		setSelected(allSelected ? new Set() : new Set(joinRows.map((w) => w.id)));

	const invalidate = () => {
		for (const key of [
			["v2", "workspaces"],
			["v2", "workspaces-context"],
			["v2", "discoverable-workspaces", orgId],
			["v2", "organisation", orgId, "workspaces"],
			["v2", "workspace-usage"],
			["v2", "workspace-projects"],
			["projects"],
		]) {
			queryClient.invalidateQueries({ queryKey: key });
		}
	};

	// Each /join is idempotent (returns already_member, never a 500), so a batched
	// allSettled is safe; failed ids stay selected for a one-click retry.
	const bulkJoin = useMutation({
		mutationFn: async (ids: string[]) => {
			const results = await Promise.allSettled(ids.map(postJoin));
			const okCount = results.filter((r) => r.status === "fulfilled").length;
			const failedIds = ids.filter((_, i) => results[i].status === "rejected");
			return { okCount, failedIds };
		},
		onSuccess: ({ okCount, failedIds }) => {
			invalidate();
			confirm.close();
			setSelected(new Set(failedIds));
			posthog?.capture("workspace_join_completed", {
				org_id: orgId,
				count: okCount,
				failed_count: failedIds.length,
			});
			if (failedIds.length === 0) {
				toast.success(
					okCount === 1
						? t`Added you to 1 workspace`
						: t`Added you to ${okCount} workspaces`,
				);
			} else {
				posthog?.capture("workspace_join_failed", {
					org_id: orgId,
					failed_count: failedIds.length,
				});
				toast.error(
					t`Added you to ${okCount}. ${failedIds.length} couldn't be added, try again.`,
				);
			}
		},
		onError: (error: Error) => {
			confirm.close();
			toast.error(error.message);
		},
	});

	const requestMutation = useMutation<
		Awaited<ReturnType<typeof postRequestAccess>>,
		Error,
		string,
		{ previous: DiscoverableWorkspace[] | undefined }
	>({
		mutationFn: postRequestAccess,
		onError: (error: Error, _workspaceId, ctx) => {
			if (ctx?.previous) {
				queryClient.setQueryData(
					["v2", "discoverable-workspaces", orgId],
					ctx.previous,
				);
			}
			toast.error(error.message);
		},
		onMutate: async (workspaceId) => {
			const key = ["v2", "discoverable-workspaces", orgId] as const;
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData<DiscoverableWorkspace[]>(key);
			queryClient.setQueryData<DiscoverableWorkspace[]>(key, (rows) =>
				(rows ?? []).map((ws) =>
					ws.id === workspaceId ? { ...ws, action: "pending" as const } : ws,
				),
			);
			return { previous };
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "discoverable-workspaces", orgId],
			});
		},
		onSuccess: (_data, workspaceId) => {
			posthog?.capture("workspace_access_requested", {
				org_id: orgId,
				workspace_id: workspaceId,
			});
			toast.success(t`Request sent`);
		},
	});

	if (isLoading || joinable.length === 0) return null;

	const headerLabel =
		joinRows.length > 0 && otherRows.length === 0
			? t`Workspaces you can join`
			: t`Discoverable in this organisation`;
	const singleName =
		selectedIds.length === 1
			? (joinRows.find((w) => w.id === selectedIds[0])?.name ?? "")
			: "";

	return (
		<>
			<Stack gap={8}>
				<UnstyledButton
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					style={{
						alignItems: "center",
						display: "inline-flex",
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
						{headerLabel}
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
						{joinRows.length > 0 && (
							<>
								<Text size="xs" c="dimmed">
									<Trans>
										Workspaces in this organisation you haven't joined yet. As
										an admin you can add yourself to manage them.
									</Trans>
								</Text>
								<Checkbox
									size="xs"
									checked={allSelected}
									indeterminate={someSelected}
									onChange={toggleAll}
									label={<Trans>Select all</Trans>}
								/>
								{joinRows.map((ws) => (
									<Paper
										key={ws.id}
										p="sm"
										radius="sm"
										withBorder
										style={{ background: "transparent" }}
									>
										<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
											<Checkbox
												size="xs"
												checked={selected.has(ws.id)}
												onChange={() => toggle(ws.id)}
												aria-label={ws.name}
											/>
											<IconLock
												size={14}
												style={{ color: "var(--mantine-color-gray-6)" }}
											/>
											<Text size="sm" lineClamp={1}>
												{ws.name}
											</Text>
											<Text size="xs" c="dimmed">
												{ws.visibility === "open_to_organisation" ? (
													<Trans>Everyone in your organisation</Trans>
												) : ws.visibility === "invite_only" ? (
													<Trans>Invite only</Trans>
												) : (
													<Trans>Private</Trans>
												)}
											</Text>
											<Text size="xs" c="dimmed">
												<Plural
													value={ws.member_count}
													one="# member"
													other="# members"
												/>
											</Text>
										</Group>
									</Paper>
								))}
								{selectedIds.length > 0 && (
									<Group justify="space-between" mt={4}>
										<Text size="xs" c="dimmed">
											<Plural
												value={selectedIds.length}
												one="# selected"
												other="# selected"
											/>
										</Text>
										<Button
											size="compact-sm"
											onClick={() => {
												posthog?.capture("workspace_join_started", {
													org_id: orgId,
													count: selectedIds.length,
												});
												confirm.open();
											}}
										>
											<Trans>Join as admin</Trans> ({selectedIds.length})
										</Button>
									</Group>
								)}
							</>
						)}
						{otherRows.map((ws) => (
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
										<Text size="xs" c="dimmed">
											<Plural
												value={ws.member_count}
												one="# member"
												other="# members"
											/>
										</Text>
									</Group>
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
			<ConfirmModal
				opened={confirmOpened}
				onClose={confirm.close}
				onConfirm={() => bulkJoin.mutate(selectedIds)}
				title={t`Join as admin?`}
				message={
					selectedIds.length === 1 ? (
						<Trans>
							You'll be added as an admin to {singleName}. It'll appear in your
							sidebar right after.
						</Trans>
					) : (
						<Trans>
							You'll be added as an admin to {selectedIds.length} private
							workspaces. They'll appear in your sidebar right after.
						</Trans>
					)
				}
				confirmLabel={<Trans>Join as admin</Trans>}
				loading={bulkJoin.isPending}
				data-testid="join-private-workspaces-modal"
			/>
		</>
	);
};
