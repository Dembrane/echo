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
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { CaretDownIcon, LockIcon } from "@phosphor-icons/react";
import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { ruleBetween } from "@/components/workspace/ruleBetween";
import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

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
		throw new ApiRequestError(res.status, data);
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
		throw new ApiRequestError(res.status, data);
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
export const DiscoverableWorkspaces = ({
	orgId,
	defaultOpen = false,
}: {
	orgId: string;
	/**
	 * Open until the viewer folds it. The organisation page passes it when the
	 * viewer has joined no workspace here, so the count in the header is never
	 * about rows the page hides.
	 */
	defaultOpen?: boolean;
}) => {
	const queryClient = useQueryClient();
	const posthog = usePostHog();
	// Collapsed by default: the list can be long and most visits are to enter a
	// workspace you already belong to, not to discover new ones. The viewer's own
	// toggle wins; until then it follows defaultOpen, which the page only knows
	// once its own workspace list has loaded.
	const [toggled, setToggled] = useState<boolean | null>(null);
	const open = toggled ?? defaultOpen;
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
	const allSelected =
		joinRows.length > 0 && selectedIds.length === joinRows.length;
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
			return { failedIds, okCount };
		},
		onError: (error: Error) => {
			confirm.close();
			void notifyError(error);
		},
		onSuccess: ({ okCount, failedIds }) => {
			invalidate();
			confirm.close();
			setSelected(new Set(failedIds));
			posthog?.capture("workspace_join_completed", {
				count: okCount,
				failed_count: failedIds.length,
				org_id: orgId,
			});
			if (failedIds.length === 0) {
				toast.success(
					okCount === 1
						? t`Added you to 1 workspace`
						: t`Added you to ${okCount} workspaces`,
				);
			} else {
				posthog?.capture("workspace_join_failed", {
					failed_count: failedIds.length,
					org_id: orgId,
				});
				toast.error(
					t`Added you to ${okCount}. ${failedIds.length} couldn't be added, try again.`,
				);
			}
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
			void notifyError(error);
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
			<Stack gap="sm">
				<UnstyledButton
					onClick={() => setToggled(!open)}
					aria-expanded={open}
					style={{
						alignItems: "flex-start",
						display: "inline-flex",
						gap: "var(--mantine-spacing-xs)",
					}}
				>
					{/* The caret keeps to the title's first line, and the count runs on in
					    the title's own text, so a title that wraps on a phone stays one
					    paragraph instead of two columns. */}
					<CaretDownIcon
						size={16}
						style={{
							flexShrink: 0,
							marginTop: "calc((1lh - 16px) / 2)",
							transform: open ? "rotate(0deg)" : "rotate(-90deg)",
							transition: "transform 0.15s ease",
						}}
					/>
					<Title order={5}>
						{headerLabel}{" "}
						<Text span size="xs" c="dimmed" fw={400}>
							<Plural
								value={joinable.length}
								one="(# workspace)"
								other="(# workspaces)"
							/>
						</Text>
					</Title>
				</UnstyledButton>
				<Collapse in={open}>
					<Stack gap="sm">
						{joinRows.length > 0 && (
							<>
								<Text size="xs" c="dimmed">
									<Trans>
										Workspaces in this organisation you haven't joined yet. As
										an admin you can add yourself to manage them.
									</Trans>
								</Text>
								{/* Only when there is more than one to select. Indented like the
								    rows below, so every box sits in one column. */}
								{joinRows.length > 1 && (
									<Checkbox
										size="xs"
										pl="sm"
										checked={allSelected}
										indeterminate={someSelected}
										onChange={toggleAll}
										label={<Trans>Select all</Trans>}
									/>
								)}
								<Paper withBorder>
									{joinRows.map((ws, i) => (
										// The row is the checkbox's own label: the box keeps to the
										// name's line and the whole row can be pressed. On a phone the
										// details go under the name as one line.
										<Checkbox
											key={ws.id}
											size="xs"
											p="sm"
											checked={selected.has(ws.id)}
											onChange={() => toggle(ws.id)}
											style={ruleBetween(i, joinRows.length)}
											styles={{
												body: { alignItems: "flex-start" },
												// Centred on the name's line (a small Text), not on the two
												// lines of a phone row.
												inner: {
													marginTop:
														"calc((var(--mantine-font-size-sm) * var(--mantine-line-height-sm) - 16px) / 2)",
												},
												labelWrapper: { flex: 1, minWidth: 0 },
											}}
											label={
												<Group gap="xs" wrap="wrap" style={{ rowGap: 0 }}>
													<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
														{/* A lock beside "Everyone in your organisation"
														    would say the opposite. */}
														{ws.visibility !== "open_to_organisation" && (
															<LockIcon
																size={16}
																color="var(--mantine-color-dimmed)"
																style={{ flexShrink: 0 }}
															/>
														)}
														<Text size="sm" lineClamp={1}>
															{ws.name}
														</Text>
													</Group>
													<Text size="xs" c="dimmed">
														{ws.visibility === "open_to_organisation" ? (
															<Trans>Everyone in your organisation</Trans>
														) : ws.visibility === "invite_only" ? (
															<Trans>Invite only</Trans>
														) : (
															<Trans>Private</Trans>
														)}
														{" · "}
														<Plural
															value={ws.member_count}
															one="# member"
															other="# members"
														/>
													</Text>
												</Group>
											}
										/>
									))}
								</Paper>
								{selectedIds.length > 0 && (
									<Group justify="flex-start" gap="sm">
										<Button
											size="compact-sm"
											variant="filled"
											onClick={() => {
												posthog?.capture("workspace_join_started", {
													count: selectedIds.length,
													org_id: orgId,
												});
												confirm.open();
											}}
										>
											<Trans>Join as admin</Trans> ({selectedIds.length})
										</Button>
										<Text size="xs" c="dimmed">
											<Plural
												value={selectedIds.length}
												one="# selected"
												other="# selected"
											/>
										</Text>
									</Group>
								)}
							</>
						)}
						{otherRows.length > 0 && (
							<Paper withBorder>
								{otherRows.map((ws, i) => (
									<Group
										key={ws.id}
										justify="space-between"
										wrap="nowrap"
										p="sm"
										style={ruleBetween(i, otherRows.length)}
									>
										<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
											{ws.visibility === "private" && (
												<LockIcon
													size={16}
													color="var(--mantine-color-dimmed)"
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
								))}
							</Paper>
						)}
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
