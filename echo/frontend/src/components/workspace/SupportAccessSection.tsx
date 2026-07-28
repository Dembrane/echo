import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";

type PendingRequest = {
	id: string;
	requested_by_name: string;
	message: string | null;
	created_at: string | null;
	expires_at: string | null;
};

type SupportAccessEvent = {
	id: string;
	event_code: string;
	created_at: string | null;
	actor_name: string | null;
	staff_name: string | null;
	params: Record<string, unknown> | null;
};

const eventLabel = (e: SupportAccessEvent): string => {
	switch (e.event_code) {
		case "toggle_enabled":
			return t`Support access turned on`;
		case "toggle_disabled":
			return t`Support access turned off`;
		case "toggle_auto_disabled":
			return t`Support access turned off after the session ended`;
		case "request_created":
			return t`dembrane staff requested access`;
		case "request_approved":
			return t`Access request approved`;
		case "request_denied":
			return t`Access request denied`;
		case "request_expired":
			return t`Access request expired`;
		case "request_cancelled":
			return t`Access request withdrawn`;
		case "staff_joined":
			return t`dembrane staff joined for support`;
		case "staff_extended":
			return t`dembrane staff extended their session`;
		case "staff_left":
			return t`dembrane staff left`;
		case "staff_auto_revoked":
			return t`dembrane staff access ended automatically`;
		case "reminder_sent":
			return t`Reminder sent: support access still on`;
		default:
			return e.event_code;
	}
};

const formatWhen = (iso: string | null): string => {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
};

export function SupportAccessSection({
	workspaceId,
	canEdit,
}: {
	workspaceId: string;
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	const [limit, setLimit] = useState(5);
	// Native scrollIntoView finds the nearest scrollable ancestor (BaseLayout's
	// inner overflow-auto); Mantine's useScrollIntoView scrolls the document.
	const sectionRef = useRef<HTMLDivElement>(null);

	const requestsKey = ["v2", "support-access", "requests", workspaceId];
	const eventsKey = ["v2", "support-access", "events", workspaceId, limit];

	const { data: requestsData } = useQuery({
		queryKey: requestsKey,
		enabled: canEdit,
		queryFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/support-access/requests`,
				{ credentials: "include" },
			);
			if (!res.ok) throw new Error(`Failed (${res.status})`);
			return res.json() as Promise<{ requests: PendingRequest[] }>;
		},
	});

	const { data: eventsData, isFetching: eventsFetching } = useQuery({
		queryKey: eventsKey,
		enabled: canEdit,
		placeholderData: keepPreviousData,
		queryFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/support-access/events?page=1&limit=${limit}`,
				{ credentials: "include" },
			);
			if (!res.ok) throw new Error(`Failed (${res.status})`);
			return res.json() as Promise<{
				events: SupportAccessEvent[];
				has_more: boolean;
			}>;
		},
	});

	const invalidateAll = () => {
		queryClient.invalidateQueries({ queryKey: ["v2", "support-access"] });
		queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
	};

	const resolveMutation = useMutation({
		mutationFn: async ({
			requestId,
			decision,
		}: {
			requestId: string;
			decision: "approve" | "deny";
		}) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/support-access/requests/${requestId}/${decision}`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.detail || `Failed (${res.status})`);
			}
			return res.json();
		},
		onError: (e) => {
			toast.error((e as Error).message);
			invalidateAll();
		},
		onSuccess: (_data, vars) => {
			toast.success(
				vars.decision === "approve"
					? t`Access granted for 24 hours.`
					: t`Request denied.`,
			);
			invalidateAll();
		},
	});

	const [confirmTarget, setConfirmTarget] = useState<PendingRequest | null>(null);
	const [confirmOpened, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);

	const pending = requestsData?.requests ?? [];
	const events = eventsData?.events ?? [];
	const hasContent = pending.length > 0 || events.length > 0;

	// Deep-link from a support notification: scroll to the section once its
	// content renders (hasContent gate makes this fire once).
	useEffect(() => {
		if (!canEdit || !hasContent) return;
		const hash = window.location.hash.replace(/^#/, "");
		if (hash === "support-access" || hash === "support-access-requests") {
			sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	}, [canEdit, hasContent]);

	if (!canEdit) return null;

	return (
		<Stack gap="md" ref={sectionRef} style={{ scrollMarginTop: 80 }}>
			{pending.length > 0 && (
				<Paper withBorder radius="sm" p="sm">
					<Stack gap="xs">
						<Text size="sm" fw={500}>
							<Trans>Pending access requests</Trans>
						</Text>
						{pending.map((req) => (
							<Group key={req.id} justify="space-between" wrap="nowrap">
								<Stack gap={0}>
									<Text size="sm">
										<Trans>{req.requested_by_name} from dembrane</Trans>
									</Text>
									{req.message && <Text size="xs">{req.message}</Text>}
									<Text size="xs">{formatWhen(req.created_at)}</Text>
								</Stack>
								<Group gap="sm" wrap="nowrap">
									<Button
										size="xs"
										variant="outline"
										color="red"
										disabled={resolveMutation.isPending}
										onClick={() =>
											resolveMutation.mutate({
												requestId: req.id,
												decision: "deny",
											})
										}
									>
										<Trans>Deny</Trans>
									</Button>
									<Button
										size="xs"
										disabled={resolveMutation.isPending}
										onClick={() => {
											setConfirmTarget(req);
											openConfirm();
										}}
									>
										<Trans>Approve</Trans>
									</Button>
								</Group>
							</Group>
						))}
					</Stack>
				</Paper>
			)}

			{events.length > 0 && (
				<Stack gap="xs">
					<Text size="sm" fw={500}>
						<Trans>Access history</Trans>
					</Text>
					{events.map((e) => (
						<Group key={e.id} justify="space-between" wrap="nowrap">
							<Text size="xs">
								{eventLabel(e)}
								{e.staff_name ? ` (${e.staff_name})` : ""}
							</Text>
							<Text size="xs">{formatWhen(e.created_at)}</Text>
						</Group>
					))}
					{eventsData?.has_more && (
						<Button
							size="xs"
							variant="subtle"
							loading={eventsFetching}
							disabled={eventsFetching}
							onClick={() => setLimit((n) => n + 10)}
						>
							<Trans>Show more</Trans>
						</Button>
					)}
				</Stack>
			)}

			{confirmTarget && (
				<ConfirmModal
					opened={confirmOpened}
					onClose={() => {
						closeConfirm();
						setConfirmTarget(null);
					}}
					onConfirm={() => {
						resolveMutation.mutate({
							requestId: confirmTarget.id,
							decision: "approve",
						});
						closeConfirm();
						setConfirmTarget(null);
					}}
					loading={resolveMutation.isPending}
					title={t`Approve support access`}
					data-testid="support-access-approve-modal"
					confirmLabel={<Trans>Approve for 24 hours</Trans>}
					message={
						<Trans>
							Give {confirmTarget.requested_by_name} from dembrane admin access to
							this workspace for 24 hours? Access ends automatically.
						</Trans>
					}
				/>
			)}
		</Stack>
	);
}
