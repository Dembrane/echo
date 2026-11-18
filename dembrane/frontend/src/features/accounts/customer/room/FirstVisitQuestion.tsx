import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useRef, useState } from "react";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import type { RoomLabelT } from "../../contract/contract.gen";
import { secondary } from "../TaskLine";
import { invitedSentence } from "./copy";
import { LabelChoices, type LabelValue } from "./LabelChoices";
import { inLabelOrder } from "./model";

/**
 * Someone brought in by a colleague, on their first visit: one light question, whether
 * what they were invited to do is right. "Yes" posts it as it is; "Change" opens the same
 * choices as adding someone, here, and posts the correction. With nothing set, it asks
 * what they do and shows the choices at once. Answered once: the card then goes.
 */
export function FirstVisitQuestion({
	inviter,
	labels,
	other,
	onAnswer,
}: {
	inviter: string | null;
	labels: RoomLabelT[];
	other: string | null;
	onAnswer: (body: {
		labels: RoomLabelT[];
		other: string | null;
	}) => Promise<unknown>;
}) {
	const blank = labels.length === 0 && !other?.trim();
	const [choosing, setChoosing] = useState(blank);
	const [value, setValue] = useState<LabelValue>({ labels, other });
	const [pending, setPending] = useState(false);
	const [answered, setAnswered] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const sent = useRef(false);

	const post = async (body: { labels: RoomLabelT[]; other: string | null }) => {
		if (sent.current) return;
		sent.current = true;
		setPending(true);
		setError(null);
		try {
			await onAnswer(body);
			setAnswered(true);
		} catch (e) {
			sent.current = false;
			setError(e);
		} finally {
			setPending(false);
		}
	};

	if (answered) return null;
	const sentence = invitedSentence({ inviter, labels, other });
	return (
		<Alert color="primary" icon={null} data-testid="first-visit">
			<Stack gap="md">
				<Text>
					{sentence}
					{!blank && (
						<>
							{" "}
							<Trans>Is that right?</Trans>
						</>
					)}
				</Text>
				{choosing ? (
					<>
						<LabelChoices
							value={value}
							onChange={setValue}
							question={t`What do you do in this decision?`}
						/>
						<Group gap="md">
							<Button
								{...secondary}
								loading={pending}
								disabled={pending}
								onClick={() =>
									post({
										labels: inLabelOrder(value.labels),
										other: value.other?.trim() || null,
									})
								}
								data-testid="first-visit-save"
							>
								<Trans>Save</Trans>
							</Button>
							{!blank && (
								<Button
									variant="subtle"
									disabled={pending}
									onClick={() => setChoosing(false)}
									data-testid="first-visit-cancel"
								>
									<Trans>Cancel</Trans>
								</Button>
							)}
						</Group>
					</>
				) : (
					<Group gap="md">
						<Button
							{...secondary}
							loading={pending}
							disabled={pending}
							onClick={() => post({ labels: inLabelOrder(labels), other })}
							data-testid="first-visit-yes"
						>
							<Trans>Yes, that is right</Trans>
						</Button>
						<Button
							{...secondary}
							disabled={pending}
							onClick={() => setChoosing(true)}
							data-testid="first-visit-change"
						>
							<Trans>Change</Trans>
						</Button>
					</Group>
				)}
				{error ? <ErrorNotice error={error} /> : null}
			</Stack>
		</Alert>
	);
}
