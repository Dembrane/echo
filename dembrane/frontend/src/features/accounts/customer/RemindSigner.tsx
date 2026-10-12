import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { call } from "../api/client";
import { accountKeys } from "../api/hooks";
import { secondary } from "./TaskLine";

/**
 * "Remind <name>" on a signature waiting on someone else: emails them their link again.
 * Remind is one of the open questions on the to-do board, so it lives here alone: to drop
 * it, delete this file and its one use in NextSteps.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * Once a full day has passed since they were named, and at most once a day after that
 * (the server holds to it too).
 */
export const mayRemind = (
	signer: { named_at: string | null; reminded_at: string | null },
	now = Date.now(),
) =>
	signer.named_at != null &&
	now - Date.parse(signer.named_at) > DAY &&
	(signer.reminded_at == null || now - Date.parse(signer.reminded_at) > DAY);

export function RemindSigner({
	orgId,
	docId,
	name,
}: {
	orgId: string;
	docId: string;
	/** Their first name, or their email when we have no name. */
	name: string;
}) {
	const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
	const queryClient = useQueryClient();
	const remind = async () => {
		setState("sending");
		try {
			await call("remindSigner", { params: { docId, orgId } });
			toast.success(t`We emailed ${name} the link again.`);
			setState("sent");
			// The next reminder waits a day; the refreshed signer says so.
			void queryClient.invalidateQueries({ queryKey: accountKeys.all });
		} catch {
			toast.error(t`The reminder did not go out. Try again in a moment.`);
			setState("idle");
		}
	};
	return (
		<Button
			{...secondary}
			loading={state === "sending"}
			disabled={state === "sent"}
			onClick={remind}
			data-testid="action-remind"
		>
			{state === "sent" ? (
				<Trans>Reminded</Trans>
			) : (
				<Trans>Remind {name}</Trans>
			)}
		</Button>
	);
}
