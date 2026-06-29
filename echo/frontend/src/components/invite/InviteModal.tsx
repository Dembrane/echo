import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Divider,
	Group,
	Modal,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { usePostHog } from "@posthog/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "@/components/common/Toaster";
import {
	type EmailChip,
	EmailChipsInput,
	type MemberSuggestion,
} from "@/components/invite/EmailChipsInput";
import {
	type InviteResultRow,
	type InviteResultState,
	InviteResultsList,
} from "@/components/invite/InviteResultsList";
import { type InviteRole, RoleSelect } from "@/components/invite/RoleSelect";
import {
	type InviteableWorkspace,
	WorkspaceSelectList,
} from "@/components/invite/WorkspaceSelectList";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";
import {
	invalidateOrgMembersEverywhere,
	invalidateOrgWorkspacesEverywhere,
	invalidatePendingInvitesEverywhere,
	orgQueryKeys,
} from "@/lib/orgQueryKeys";

interface Props {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	orgName: string;
	/** When opened from a workspace members page, pre-checks that workspace. */
	defaultWorkspaceId?: string;
}

async function fetchOrgWorkspaces(
	orgId: string,
): Promise<InviteableWorkspace[]> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/workspaces`, {
		credentials: "include",
	});
	// Throw rather than [] — empty list is indistinguishable from "no inviteable workspaces".
	if (!res.ok) {
		throw new Error(`Workspaces request failed (${res.status})`);
	}
	const data = await res.json();
	if (!Array.isArray(data)) {
		throw new Error("Workspaces response was not an array");
	}
	return data as InviteableWorkspace[];
}

// Minimal shape of GET /v2/orgs/:id/members — only the fields the autocomplete needs.
type OrgMemberLite = {
	email: string;
	display_name: string;
	is_external?: boolean;
};

// Best-effort: suggestions are a convenience, so a failed/forbidden fetch yields
// an empty list rather than breaking the modal.
async function fetchOrgMembers(orgId: string): Promise<OrgMemberLite[]> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/members`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	const data = await res.json().catch(() => null);
	return Array.isArray(data) ? (data as OrgMemberLite[]) : [];
}

type WorkspaceInvitePayload = {
	status: string;
	email: string;
	email_sent: boolean;
	invite_url?: string | null;
};

async function inviteToWorkspace(
	workspaceId: string,
	email: string,
	role: InviteRole,
): Promise<WorkspaceInvitePayload> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`,
		{
			body: JSON.stringify({ email, role }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(
			(data && (data.detail as string)) ||
				`Workspace invite failed (${res.status})`,
		);
		(err as Error & { status?: number }).status = res.status;
		throw err;
	}
	return data as WorkspaceInvitePayload;
}

async function inviteToOrg(
	orgId: string,
	email: string,
	role: InviteRole,
): Promise<{ status: string; email: string; invite_url?: string | null }> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/invites`, {
		body: JSON.stringify({ email, role }),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(
			(data && (data.detail as string)) || `Org invite failed (${res.status})`,
		);
		(err as Error & { status?: number }).status = res.status;
		throw err;
	}
	return data as { status: string; email: string; invite_url?: string | null };
}

// One row of the cost preview, scoped to a single billing context (the org's
// pooled account, or a partner workspace's own account).
type ConfirmLine = {
	label: string;
	billsSeparately: boolean;
	addedSeats: number;
	proratedNow: number;
	recurringDelta: number;
	billingPeriod: string;
	/** Seats covered by capacity already paid for this period (free now). */
	coveredByExisting: number;
};

type SeatEstimate = {
	active: boolean;
	/** Net-new seats the server actually charges for (recipients already on the
	 *  account are deduped out). */
	added_seats: number;
	prorated_now_eur: number;
	recurring_delta_eur: number;
	/** Invited seats covered by capacity already paid for this period (free now). */
	covered_by_existing_seats: number;
	currency: string;
	/** Cadence of the account's plan ("annual" | "monthly"); cycles can differ across contexts. */
	billing_period: string;
};

async function fetchSeatEstimate(
	workspaceId: string,
	emails: string[],
): Promise<SeatEstimate | null> {
	// Send the recipient emails so the server computes net-new seats: a recipient
	// already holding a seat anywhere on the account, or already pending, costs
	// nothing (seats are pooled). The server never echoes the roster back.
	const qs = new URLSearchParams({ emails: emails.join(",") });
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/seat-estimate?${qs}`,
		{ credentials: "include" },
	);
	if (!res.ok) return null;
	return (await res.json()) as SeatEstimate;
}

function mapHttpStatusToState(
	status: number | undefined,
	detail?: string,
): InviteResultState {
	// Both seat-cap and "billing inactive" return 402; the detail disambiguates.
	if (status === 402) {
		return detail?.toLowerCase().includes("reactivate")
			? "reactivate_required"
			: "seat_cap";
	}
	if (status === 429) return "rate_limited";
	// 409 isn't returned anymore (duplicate-pending is a 200 with status "already_invited"); kept defensively.
	if (status === 409) return "already_invited";
	return "failed";
}

// Unified invite modal: org is the subject, workspaces are optional. Zero-workspace submit hits /v2/orgs/:id/invites; otherwise fans out per (email, workspace) to /v2/workspaces/:id/invite.
export function InviteModal({
	opened,
	onClose,
	orgId,
	orgName,
	defaultWorkspaceId,
}: Props) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const posthog = usePostHog();
	const { data: me } = useV2Me();
	const { workspaces: myWorkspaces } = useWorkspace();

	const [chips, setChips] = useState<EmailChip[]>([]);
	const [role, setRole] = useState<InviteRole>("member");
	const [selectedWorkspaces, setSelectedWorkspaces] = useState<Set<string>>(
		new Set(),
	);
	const [results, setResults] = useState<InviteResultRow[]>([]);
	// Prorated cost preview shown before sending a paid, seat-consuming invite.
	// One line per BILLING CONTEXT (not per workspace): all pooled workspaces
	// share the org account so they're charged once, while each partner
	// workspace is its own account with its own cadence.
	const [confirm, setConfirm] = useState<ConfirmLine[] | null>(null);
	const [estimating, setEstimating] = useState(false);

	// Owners/admins get the zero-workspace submit path; everyone else must pick a workspace.
	const myOrgRole = useMemo(() => {
		if (!me) return undefined;
		return me.orgs.find((o) => o.id === orgId)?.role;
	}, [me, orgId]);
	const canInviteOrgOnly = myOrgRole === "admin" || myOrgRole === "owner";

	// Ceiling = max(org role, highest workspace role in this org); backend enforces per-call.
	const inviterLevel: "member" | "admin" | "owner" = useMemo(() => {
		if (myOrgRole === "owner") return "owner";
		const wsLevels = myWorkspaces
			.filter((w) => w.org_id === orgId)
			.map((w) => w.role);
		if (myOrgRole === "admin" || wsLevels.includes("owner")) return "admin";
		if (wsLevels.includes("admin")) return "admin";
		return "member";
	}, [myOrgRole, myWorkspaces, orgId]);

	// Reset state on each open so a re-open after submit doesn't show stale results.
	useEffect(() => {
		if (!opened) return;
		setChips([]);
		setRole("member");
		setResults([]);
		setSelectedWorkspaces(
			defaultWorkspaceId ? new Set([defaultWorkspaceId]) : new Set(),
		);
	}, [opened, defaultWorkspaceId]);

	const {
		data: allWorkspaces = [],
		isLoading: workspacesLoading,
		isError: workspacesLoadError,
	} = useQuery({
		enabled: opened && Boolean(orgId),
		queryFn: () => fetchOrgWorkspaces(orgId),
		queryKey: ["v2", "orgs", orgId, "workspaces", "invite-modal"],
		staleTime: 30_000,
	});

	// Org admins/owners get a people-picker so they can add existing org members
	// without retyping emails. Everyone else keeps the plain free-text input.
	const { data: orgMembers = [] } = useQuery({
		enabled: opened && canInviteOrgOnly && Boolean(orgId),
		queryFn: () => fetchOrgMembers(orgId),
		queryKey: orgQueryKeys.members(orgId),
		staleTime: 60_000,
	});

	const memberSuggestions = useMemo<MemberSuggestion[] | undefined>(() => {
		if (!canInviteOrgOnly) return undefined;
		const selfLower = me?.email?.toLowerCase();
		return orgMembers
			.filter((m) => !m.is_external && m.email)
			.filter((m) => m.email.toLowerCase() !== selfLower)
			.map((m) => ({ displayName: m.display_name, email: m.email }));
	}, [canInviteOrgOnly, orgMembers, me?.email]);

	// Org admins/owners can invite everywhere; workspace admins only to workspaces they admin.
	const inviteableWorkspaces = useMemo<InviteableWorkspace[]>(() => {
		if (canInviteOrgOnly) return allWorkspaces;
		const myAdminWsIds = new Set(
			myWorkspaces
				.filter(
					(w) =>
						w.org_id === orgId && (w.role === "admin" || w.role === "owner"),
				)
				.map((w) => w.id),
		);
		return allWorkspaces.filter((w) => myAdminWsIds.has(w.id));
	}, [allWorkspaces, canInviteOrgOnly, myWorkspaces, orgId]);

	const validChips = chips.filter((c) => c.state === "valid");
	const hasInvalidChips = chips.some((c) => c.state !== "valid");
	const pendingCount = validChips.length;

	// Distinct billing contexts the current selection spans: all pooled (org)
	// workspaces share one account, while each separately-billed (partner)
	// workspace is its own. >1 means a recipient takes a seat in several
	// independently-billed accounts, which we call out before sending.
	const billingContextCount = useMemo(() => {
		let pooled = false;
		let separate = 0;
		for (const id of selectedWorkspaces) {
			const ws = inviteableWorkspaces.find((w) => w.id === id);
			if (!ws) continue;
			if (ws.bills_separately) separate += 1;
			else pooled = true;
		}
		return separate + (pooled ? 1 : 0);
	}, [selectedWorkspaces, inviteableWorkspaces]);

	const toggleWorkspace = (workspaceId: string) => {
		setSelectedWorkspaces((prev) => {
			const next = new Set(prev);
			if (next.has(workspaceId)) next.delete(workspaceId);
			else next.add(workspaceId);
			return next;
		});
	};

	const zeroWorkspaceSubmit = selectedWorkspaces.size === 0;
	const workspaceAdminBlocked = zeroWorkspaceSubmit && !canInviteOrgOnly;
	// External and observer are workspace-scoped outsiders (no org_membership);
	// gate at the modal so the user never hits the backend 422 / wrong org path.
	const externalNeedsWorkspace =
		(role === "external" || role === "observer") && zeroWorkspaceSubmit;

	// The free observer role exists only in external-client (partner)
	// workspaces — those billed separately. Block observer when any selected
	// workspace is internal-use (the backend rejects it too).
	const selectedAreAllExternalClient =
		selectedWorkspaces.size > 0 &&
		Array.from(selectedWorkspaces).every(
			(id) => inviteableWorkspaces.find((w) => w.id === id)?.bills_separately,
		);
	const observerNeedsExternalWorkspace =
		role === "observer" &&
		!zeroWorkspaceSubmit &&
		!selectedAreAllExternalClient;

	const canSubmit =
		validChips.length > 0 &&
		!hasInvalidChips &&
		!workspaceAdminBlocked &&
		!externalNeedsWorkspace &&
		!observerNeedsExternalWorkspace;

	type SubmitResult = {
		rows: InviteResultRow[];
		// Snapshot at submit so onSuccess can't read stale closure values.
		emailCount: number;
		workspaceIds: string[];
		role: InviteRole;
	};

	const submit = useMutation<SubmitResult>({
		mutationFn: async (): Promise<SubmitResult> => {
			const emails = validChips.map((c) => c.value.trim().toLowerCase());
			const workspaceIds = Array.from(selectedWorkspaces);
			const submittedRole = role;
			const workspaceMap = new Map(
				inviteableWorkspaces.map((w) => [w.id, w.name]),
			);

			type Call = {
				email: string;
				workspaceId: string | null;
				workspaceName: string | null;
				run: () => Promise<WorkspaceInvitePayload | { status: string }>;
			};
			const calls: Call[] = [];

			if (workspaceIds.length === 0) {
				// Zero-workspace path: one call per email to the org-only endpoint.
				for (const email of emails) {
					calls.push({
						email,
						run: () => inviteToOrg(orgId, email, role),
						workspaceId: null,
						workspaceName: null,
					});
				}
			} else {
				for (const email of emails) {
					for (const wsId of workspaceIds) {
						calls.push({
							email,
							run: () => inviteToWorkspace(wsId, email, role),
							workspaceId: wsId,
							workspaceName: workspaceMap.get(wsId) ?? null,
						});
					}
				}
			}

			// Cap concurrency: 20 emails × 5 workspaces = 100 in-flight POSTs would trip the per-account 429.
			const CONCURRENCY = 4;
			const settled: PromiseSettledResult<
				WorkspaceInvitePayload | { status: string }
			>[] = new Array(calls.length);
			let cursor = 0;
			const workers = Array.from(
				{ length: Math.min(CONCURRENCY, calls.length) },
				async () => {
					while (true) {
						const idx = cursor++;
						if (idx >= calls.length) return;
						try {
							const value = await calls[idx].run();
							settled[idx] = { status: "fulfilled", value };
						} catch (reason) {
							settled[idx] = { reason, status: "rejected" };
						}
					}
				},
			);
			await Promise.all(workers);

			const rows = settled.map((res, i) => {
				const call = calls[i];
				if (res.status === "fulfilled") {
					const value = res.value as {
						status?: string;
						invite_url?: string | null;
					};
					const status = value.status ?? "sent";
					// invited/added/reactivated → sent; already_member / already_invited surface as their own states.
					let state: InviteResultState = "sent";
					if (status === "already_member") state = "already_member";
					else if (status === "already_invited") state = "already_invited";
					return {
						email: call.email,
						inviteUrl: value.invite_url ?? null,
						state,
						workspaceId: call.workspaceId,
						workspaceName: call.workspaceName,
					};
				}
				const err = res.reason as Error & { status?: number };
				const state = mapHttpStatusToState(err.status, err.message);
				return {
					detail: err.message,
					email: call.email,
					state,
					workspaceId: call.workspaceId,
					workspaceName: call.workspaceName,
				};
			});

			return {
				emailCount: emails.length,
				role: submittedRole,
				rows,
				workspaceIds,
			};
		},
		onError: (e: Error) => toast.error(e.message),
		onSuccess: ({ rows, emailCount, workspaceIds, role: submittedRole }) => {
			setResults(rows);
			// Telemetry on input intent, not result counts (429s still count as attempts).
			posthog?.capture("invite_sent", {
				count: emailCount,
				role: submittedRole,
				workspace_count: workspaceIds.length,
			});
			// Centralised helpers fan out to both query namespaces during the migration window.
			invalidateOrgMembersEverywhere(queryClient, orgId);
			invalidatePendingInvitesEverywhere(queryClient, orgId);
			for (const wsId of workspaceIds) {
				invalidatePendingInvitesEverywhere(queryClient, orgId, wsId);
			}
			invalidateOrgWorkspacesEverywhere(queryClient, orgId);
			queryClient.invalidateQueries({
				queryKey: ["v2", "orgs", orgId, "workspaces", "invite-modal"],
			});
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			// Pending invites count toward the seat cap; refresh seat gating.
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-usage"] });

			// already_member / already_invited are idempotent outcomes, not failures.
			const sentCount = rows.filter((r) => r.state === "sent").length;
			const idempotentCount = rows.filter(
				(r) => r.state === "already_member" || r.state === "already_invited",
			).length;
			const okCount = sentCount + idempotentCount;
			const failedCount = rows.length - okCount;
			if (failedCount === 0) {
				toast.success(
					sentCount === 1 && idempotentCount === 0
						? t`Invite sent.`
						: sentCount === 0
							? t`No new invites needed. Check the list below.`
							: t`${sentCount} invites sent.`,
				);
			} else if (okCount === 0) {
				toast.error(t`No invites went out. Check the list below.`);
			} else {
				toast.error(
					t`Sent ${sentCount} of ${rows.length}. Check the list below.`,
				);
			}
		},
	});

	// Changing the recipients, role, or workspaces invalidates the preview.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional, reset the preview when recipients, role, or workspaces change
	useEffect(() => {
		setConfirm(null);
	}, [chips, role, selectedWorkspaces]);

	const fmtEur = (n: number) => `€${n.toFixed(2)}`;

	// Workspace invites consume a seat and may incur a prorated charge, so show a
	// cost preview before sending. Org-only (zero-workspace) invites don't.
	const handleSend = async () => {
		const workspaceIds = Array.from(selectedWorkspaces);
		if (workspaceIds.length > 0 && role !== "observer" && !confirm) {
			setEstimating(true);
			try {
				const emails = validChips.map((c) => c.value.trim().toLowerCase());
				const selected = workspaceIds
					.map((id) => inviteableWorkspaces.find((w) => w.id === id))
					.filter((w): w is InviteableWorkspace => Boolean(w));
				// One estimate per billing context. Pooled workspaces share the org
				// account, so querying any one of them covers them all (querying each
				// would double-count the same charge); each partner workspace is its
				// own account with its own cadence.
				const pooled = selected.filter((w) => !w.bills_separately);
				const separate = selected.filter((w) => w.bills_separately);
				const contexts: {
					id: string;
					label: string;
					billsSeparately: boolean;
				}[] = [];
				if (pooled.length > 0) {
					contexts.push({
						billsSeparately: false,
						id: pooled[0].id,
						label: orgName,
					});
				}
				for (const w of separate) {
					contexts.push({ billsSeparately: true, id: w.id, label: w.name });
				}

				const estimates = await Promise.all(
					contexts.map(async (c) => ({
						c,
						est: await fetchSeatEstimate(c.id, emails),
					})),
				);
				const lines: ConfirmLine[] = [];
				for (const { c, est } of estimates) {
					if (
						est?.active &&
						(est.prorated_now_eur > 0 || est.recurring_delta_eur > 0)
					) {
						lines.push({
							addedSeats: est.added_seats,
							billingPeriod: est.billing_period,
							billsSeparately: c.billsSeparately,
							coveredByExisting: est.covered_by_existing_seats ?? 0,
							label: c.label,
							proratedNow: est.prorated_now_eur,
							recurringDelta: est.recurring_delta_eur,
						});
					}
				}
				if (lines.length > 0) {
					setConfirm(lines);
					return;
				}
			} catch {
				// Estimate is best-effort: fall through and send if it fails.
			} finally {
				setEstimating(false);
			}
		}
		setConfirm(null);
		submit.mutate();
	};

	// Don't block close while the fan-out runs (e.g. 20×5 = 100 sequential calls ~30s); mutation continues in the background.
	const onCloseClick = () => {
		onClose();
	};

	return (
		<Modal
			opened={opened}
			onClose={onCloseClick}
			centered
			size="lg"
			title={
				<Title order={4} fw={500}>
					<Trans>Invite people to {orgName}</Trans>
				</Title>
			}
			data-testid="invite-modal"
		>
			<Stack gap="md">
				{results.length === 0 ? (
					<>
						<EmailChipsInput
							chips={chips}
							onChipsChange={setChips}
							selfEmail={me?.email ?? null}
							suggestions={memberSuggestions}
							data-testid="invite-modal-emails"
						/>

						<RoleSelect
							value={role}
							onChange={setRole}
							inviterLevel={inviterLevel}
							data-testid="invite-modal-role"
						/>

						<Divider
							label={<Trans>Add to workspaces</Trans>}
							labelPosition="left"
						/>

						{workspacesLoadError ? (
							<Alert color="red" variant="light" p="xs">
								<Text size="xs">
									<Trans>
										Couldn't load workspaces. Close and reopen to retry.
									</Trans>
								</Text>
							</Alert>
						) : (
							<WorkspaceSelectList
								workspaces={inviteableWorkspaces}
								selected={selectedWorkspaces}
								onToggle={toggleWorkspace}
								pendingCount={pendingCount}
								loading={workspacesLoading}
								data-testid="invite-modal-workspaces"
							/>
						)}

						{billingContextCount > 1 && (
							<Text size="xs" c="dimmed" data-testid="invite-billing-contexts">
								<Trans>
									These workspaces are billed separately. Each person you add
									takes a seat in {billingContextCount} billing contexts, each
									invoiced on its own.
								</Trans>
							</Text>
						)}

						{zeroWorkspaceSubmit &&
							(externalNeedsWorkspace ? (
								<Alert
									color="yellow"
									variant="light"
									p="xs"
									styles={{ wrapper: { alignItems: "center" } }}
								>
									<Text size="xs">
										<Trans>
											Externals only exist inside a workspace. Pick at least one
											to send the invite.
										</Trans>
									</Text>
								</Alert>
							) : canInviteOrgOnly ? (
								<Alert color="gray" variant="light" p="xs">
									<Text size="xs">
										<Trans>
											No workspace picked. They'll be added to {orgName} and can
											request workspace access themselves.
										</Trans>
									</Text>
								</Alert>
							) : (
								<Alert color="yellow" variant="light" p="xs">
									<Text size="xs">
										<Trans>
											Pick at least one workspace to send the invite.
										</Trans>
									</Text>
								</Alert>
							))}

						{observerNeedsExternalWorkspace && (
							<Alert color="yellow" variant="light" p="xs">
								<Text size="xs">
									<Trans>
										Observers are only available in workspaces for an external
										client. Pick only external-client workspaces, or choose a
										different role.
									</Trans>
								</Text>
							</Alert>
						)}
					</>
				) : (
					<>
						<Text size="sm" c="dimmed">
							<Trans>Per-recipient results:</Trans>
						</Text>
						<InviteResultsList
							rows={results}
							data-testid="invite-modal-results"
						/>
						{results.some((r) => r.state === "reactivate_required") && (
							<Alert color="yellow" variant="light" p="xs">
								<Group justify="space-between" wrap="nowrap" gap="sm">
									<Text size="xs">
										<Trans>
											Your plan is inactive. Reactivate it to add members.
										</Trans>
									</Text>
									<Button
										size="xs"
										onClick={() => navigate(`/o/${orgId}/settings/billing`)}
									>
										<Trans>Reactivate</Trans>
									</Button>
								</Group>
							</Alert>
						)}
					</>
				)}

				{confirm && confirm.length > 0 && results.length === 0 && (
					<Alert variant="light" p="sm" data-testid="invite-proration-confirm">
						<Stack gap={8}>
							{confirm.length > 1 && (
								<Text size="sm" fw={500}>
									<Trans>
										This invite spans {confirm.length} billing contexts, each
										invoiced on its own:
									</Trans>
								</Text>
							)}
							{confirm.map((line) => {
								const cadence =
									line.billingPeriod === "monthly" ? t`mo` : t`yr`;
								return (
									<Group
										key={line.label}
										justify="space-between"
										wrap="nowrap"
										gap="sm"
										align="flex-start"
									>
										<Text size="xs">
											{line.label}
											{line.billsSeparately ? " (Partner)" : ""}
										</Text>
										<Text size="xs" ta="right">
											<Trans>
												{line.addedSeats} seat(s) · {fmtEur(line.proratedNow)}{" "}
												now · +{fmtEur(line.recurringDelta)}/{cadence} at
												renewal
											</Trans>
										</Text>
									</Group>
								);
							})}
							{confirm.some((l) => l.coveredByExisting > 0) && (
								<Text size="xs">
									<Trans>
										You're reusing seats you already paid for this period
										(someone left), so there's no charge now for those. The
										renewal reflects them.
									</Trans>
								</Text>
							)}
							{confirm.length > 1 ? (
								<>
									<Divider my={2} />
									<Group justify="space-between" wrap="nowrap">
										<Text size="xs" fw={500}>
											<Trans>Total due now</Trans>
										</Text>
										<Text size="xs" fw={500}>
											{fmtEur(
												confirm.reduce((sum, l) => sum + l.proratedNow, 0),
											)}
										</Text>
									</Group>
								</>
							) : (
								<Text size="xs" c="dimmed">
									<Trans>Prorated for the rest of this billing period.</Trans>
								</Text>
							)}
						</Stack>
					</Alert>
				)}

				<Group justify="flex-end" gap="xs">
					<Button
						variant="subtle"
						onClick={onCloseClick}
						disabled={submit.isPending}
					>
						{results.length > 0 ? <Trans>Done</Trans> : <Trans>Cancel</Trans>}
					</Button>
					{results.length === 0 && (
						<Button
							onClick={() => void handleSend()}
							loading={submit.isPending || estimating}
							disabled={!canSubmit}
							data-testid="invite-modal-send"
						>
							{confirm ? (
								<Trans>Confirm and send</Trans>
							) : selectedWorkspaces.size > 0 ? (
								<Trans>Next</Trans>
							) : validChips.length > 1 ? (
								<Trans>Send {validChips.length} invites</Trans>
							) : (
								<Trans>Send invite</Trans>
							)}
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}
