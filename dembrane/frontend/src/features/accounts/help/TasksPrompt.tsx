import { plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import type { TasksSummaryT } from "../contract/contract.gen";
import { nextTaskText } from "../format";
import { useAccountsCatalog } from "../i18n";
import { markPromptSeen, promptFor, promptSeen } from "./tasksPromptState";
import { useTasksSummary } from "./tasksSummary";

type Row = TasksSummaryT[number];

/**
 * After sign-in, for someone with tasks waiting on them: how many, in which organisation,
 * and the next one, with one way to the tasks and a quiet "Later". It shows at most once
 * per sign-in and never on that organisation's overview or Tasks page itself. It comes before What's
 * new: `onSettled` fires once it will not show or once it closes, and What's new waits
 * for it, so two modals never stack. Loaded lazily by HelpBlock, like the Tasks entry.
 */
export default function TasksPrompt({ onSettled }: { onSettled: () => void }) {
	const { data, status } = useTasksSummary();
	const catalogReady = useAccountsCatalog();
	const navigate = useI18nNavigate();
	const { pathname } = useLocation();
	const [row, setRow] = useState<Row | null>(null);
	const decided = useRef(false);

	// Decided once per mount, on the first answer: a later refresh of the summary (any
	// account write refreshes it) never brings the popup back.
	useEffect(() => {
		if (decided.current || status === "pending") return;
		decided.current = true;
		const next = promptSeen() ? null : promptFor(data);
		if (!next || onOrgPage(pathname, next.org_id)) {
			if (next) markPromptSeen();
			onSettled();
			return;
		}
		markPromptSeen();
		setRow(next);
	}, [data, onSettled, pathname, status]);

	const close = (then?: () => void) => {
		setRow(null);
		onSettled();
		then?.();
	};

	if (!row || !catalogReady) return null;
	const name = row.name;
	const next = nextTaskText(row);
	return (
		<Modal
			opened
			centered
			// "Later" is the one quiet way out; Escape and the backdrop do the same.
			withCloseButton={false}
			onClose={() => close()}
			title={plural(row.tasks_waiting, {
				one: `You have # thing to do in ${name}`,
				other: `You have # things to do in ${name}`,
			})}
			data-testid="tasks-prompt"
		>
			<Stack gap="lg">
				{next && (
					<Text size="sm">
						<Trans>Next: {next}</Trans>
					</Text>
				)}
				<Group gap="sm">
					<Button
						variant="filled"
						onClick={() => close(() => navigate(`/o/${row.org_id}/overview`))}
					>
						<Trans>Go to your tasks</Trans>
					</Button>
					<Button variant="subtle" color="gray" onClick={() => close()}>
						<Trans>Later</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

/** On the organisation's overview or Tasks page, where the popup would only repeat it. */
const onOrgPage = (pathname: string, orgId: string) =>
	new RegExp(`/o/${orgId}/(overview|tasks|account)/?$`).test(pathname);
