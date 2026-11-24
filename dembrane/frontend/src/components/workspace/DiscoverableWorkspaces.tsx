import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Accordion,
	Box,
	Button,
	Checkbox,
	Group,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { FoldersIcon, InfoIcon } from "@phosphor-icons/react";
import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { API_BASE_URL } from "@/config";
import {
	PageSection,
	Row,
	Rows,
} from "@/features/accounts/customer/PageSection";
// The ruled list's grid and its fold, as "Involved in procurement" and "Other members"
// draw them on the same page: one look for every list of the organisation page.
import list from "@/features/accounts/customer/room/PeopleList.module.css";
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
	standalone = false,
}: {
	orgId: string;
	/**
	 * The viewer has joined no workspace here, so this list is all the page says
	 * about workspaces: it gets a section heading and shows its rows, instead of
	 * folding under the viewer's own workspaces. The count in the page's header is
	 * then never about rows the page hides.
	 */
	standalone?: boolean;
}) => {
	const queryClient = useQueryClient();
	const posthog = usePostHog();
	// Folded by default: the list can be long and most visits are to enter a
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

	const count = (
		<Text span size="xs" c="dimmed" ml="xs">
			{joinable.length}
		</Text>
	);
	// What the list is, behind the info icon, as the people list keeps its own note.
	const about = joinRows.length > 0 && (
		<Tooltip
			multiline
			w={280}
			label={t`Workspaces in this organisation you haven't joined yet. As an admin you can add yourself to manage them.`}
		>
			<InfoIcon size={16} className={list.info} />
		</Tooltip>
	);
	const details = (ws: DiscoverableWorkspace) => (
		<Text size="xs" lh="20px" c="dimmed">
			{ws.visibility === "open_to_organisation" ? (
				<Trans>Everyone in your organisation</Trans>
			) : ws.visibility === "invite_only" ? (
				<Trans>Invite only</Trans>
			) : (
				<Trans>Private</Trans>
			)}
			{" · "}
			<Plural value={ws.member_count} one="# member" other="# members" />
		</Text>
	);
	// One row per workspace on the list's grid: the box where a person's picture
	// sits, the name over its details, and what you can ask for beside them. The
	// row is the box's label, so pressing anywhere on it ticks it.
	const rows = (
		<>
			<Rows>
				{joinRows.length > 1 && (
					<Row>
						<Box component="label" className={list.person}>
							<div className={list.marker}>
								<Checkbox
									checked={allSelected}
									indeterminate={someSelected}
									onChange={toggleAll}
								/>
							</div>
							<Text lh="24px" className={list.wide}>
								<Trans>Select all</Trans>
							</Text>
						</Box>
					</Row>
				)}
				{joinRows.map((ws) => (
					<Row key={ws.id}>
						<Box component="label" className={list.person}>
							<div className={list.marker}>
								<Checkbox
									checked={selected.has(ws.id)}
									onChange={() => toggle(ws.id)}
								/>
							</div>
							<div className={`${list.who} ${list.wide}`}>
								<Text lh="24px">{ws.name}</Text>
								{details(ws)}
							</div>
						</Box>
					</Row>
				))}
				{otherRows.map((ws) => (
					<Row key={ws.id}>
						<div className={list.person}>
							{/* Nothing to tick here, so the column says what the row is. */}
							<div className={list.marker}>
								<FoldersIcon size={20} color="var(--app-muted)" aria-hidden />
							</div>
							<div className={list.who}>
								<Text lh="24px">{ws.name}</Text>
								{details(ws)}
							</div>
							<div className={list.tags}>
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
									<Text size="xs" lh="24px" c="dimmed" fs="italic">
										<Trans>Request sent</Trans>
									</Text>
								)}
							</div>
							<div />
						</div>
					</Row>
				))}
			</Rows>
			{selectedIds.length > 0 && (
				<Group justify="flex-start" gap="sm" mt="sm">
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
	);

	return (
		<>
			{standalone ? (
				<PageSection
					title={
						<span>
							{headerLabel}
							{count}
							{about}
						</span>
					}
				>
					{rows}
				</PageSection>
			) : (
				<Accordion
					chevronPosition="left"
					classNames={{
						content: list.foldContent,
						control: list.foldControl,
						item: list.foldItem,
					}}
					value={open ? "join" : null}
					onChange={(value) => setOpen(value === "join")}
				>
					<Accordion.Item value="join">
						<Accordion.Control>
							<Text span>{headerLabel}</Text>
							{count}
						</Accordion.Control>
						<Accordion.Panel>{rows}</Accordion.Panel>
					</Accordion.Item>
				</Accordion>
			)}
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
