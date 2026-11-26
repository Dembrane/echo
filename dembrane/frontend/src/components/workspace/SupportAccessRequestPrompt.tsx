import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { PersonNote } from "@/components/common/PersonNote";
import {
	useMarkNotificationRead,
	useNotifications,
} from "@/hooks/useNotifications";
import {
	markRequestSeen,
	useSupportRequestPromptState,
} from "./supportRequestPromptState";
import {
	useResolveSupportRequest,
	useWaitingSupportRequests,
	type WaitingSupportRequest,
} from "./supportRequests";

const TEST_ID = "support-access-request-prompt";

/** The host's Present view: a staff name must not land on a projector mid-event. */
const onPresent = (pathname: string) => /\/present(\/|$)/.test(pathname);

/** Another dialog is open; this one waits for the next refetch or route change. */
const otherDialogOpen = () =>
	Boolean(
		document.querySelector(
			`.mantine-Modal-root:not([data-testid="${TEST_ID}"]) .mantine-Modal-content`,
		),
	);

/**
 * The consent dialog for a support access request: a workspace admin answers it where they
 * are, one request at a time, oldest first. It opens by itself once per request per browser
 * session, and again whenever the inbox asks for it. Loaded lazily by BaseLayout.
 */
export default function SupportAccessRequestPrompt() {
	const waiting = useWaitingSupportRequests();
	const { seen, asked } = useSupportRequestPromptState();
	const { pathname } = useLocation();
	const { dataUpdatedAt } = useNotifications();
	const resolve = useResolveSupportRequest();
	const markRead = useMarkNotificationRead();
	const [autoId, setAutoId] = useState<string | null>(null);

	// The ids as one string: waiting is a new array on every render.
	const waitingKey = waiting.map((r) => r.id).join(",");
	// Picks the request that opens by itself, and keeps it until it is answered or closed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: each inbox refetch looks again, in case another dialog has closed.
	useEffect(() => {
		const ids = waitingKey ? waitingKey.split(",") : [];
		if (autoId && ids.includes(autoId) && !seen.includes(autoId)) return;
		const next = ids.find((id) => !seen.includes(id)) ?? null;
		setAutoId(next && !onPresent(pathname) && !otherDialogOpen() ? next : null);
	}, [waitingKey, seen, pathname, autoId, dataUpdatedAt]);

	const current =
		waiting.find((r) => r.id === asked) ??
		waiting.find((r) => r.id === autoId && !seen.includes(r.id)) ??
		null;
	// Holds the text while the dialog fades out after an answer.
	const shown = useRef<WaitingSupportRequest | null>(null);
	if (current) shown.current = current;
	const request = current ?? shown.current;
	if (!request) return null;

	const answer = (decision: "approve" | "deny") => {
		if (!current || resolve.isPending) return;
		resolve.mutate(
			{ decision, requestId: current.id, workspaceId: current.workspace_id },
			{
				// Remembered only once answered: after a network error the request still
				// waits, so the dialog stays to try again. A request answered elsewhere or
				// expired drops out of the refetched list, and the dialog with it.
				onSuccess: () => {
					markRequestSeen(current.id);
					if (current.notification_id) markRead.mutate(current.notification_id);
				},
			},
		);
	};

	const name = request.requested_by_name;
	const workspaceName = request.workspace_name;
	const note = request.message;
	return (
		<ConfirmModal
			opened={Boolean(current)}
			onClose={() => {
				if (current) markRequestSeen(current.id);
			}}
			onConfirm={() => answer("approve")}
			onCancel={() => answer("deny")}
			loading={resolve.isPending && resolve.variables?.decision === "approve"}
			title={t`Support access request`}
			data-testid={TEST_ID}
			confirmLabel={<Trans>Approve for 24 hours</Trans>}
			cancelLabel={<Trans>Decline</Trans>}
			// It opens by itself: focus starts on the text, so nothing is answered by Enter.
			focusBody
			message={
				<Trans>
					{name} from dembrane asks for admin access to{" "}
					<strong>{workspaceName}</strong> for 24 hours, to help you with
					support. Access ends automatically.
				</Trans>
			}
			// Their own words, beside their picture. Without a note there is nothing to quote.
			detail={
				note ? (
					<PersonNote
						person={{ avatar: request.requested_by_avatar, name }}
						label={t`Note from ${name}`}
						data-testid={`${TEST_ID}-note`}
					>
						{note}
					</PersonNote>
				) : null
			}
		/>
	);
}
