import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Group, Stack, Text, TextInput } from "@mantine/core";
import { SignatureIcon } from "@phosphor-icons/react";
import { signText } from "./copy";
import { Choice } from "./LabelChoices";
import type { SignKind } from "./model";
import classes from "./SigningChoice.module.css";

/**
 * Who signs, set in the same flow as what someone does, and kept apart from it: under a
 * rule, its own question. Each document is a choice like the labels above it (the
 * grammar's `app-choice`), led by the pen. One person signs each document, so choosing
 * someone where another signs says whom they replace. The job title goes on the
 * signature, so it is asked only once a signing duty is chosen.
 */
export function SigningChoice({
	kinds,
	chosen,
	own,
	holders,
	onToggle,
	job,
	onJob,
}: {
	/** The documents waiting for a signature. */
	kinds: SignKind[];
	chosen: SignKind[];
	/** The documents this person signs now: shown chosen, not undone here. */
	own: SignKind[];
	/** Who else signs each now, by name. */
	holders: Partial<Record<SignKind, string>>;
	onToggle: (kind: SignKind) => void;
	job: string;
	onJob: (job: string) => void;
}) {
	if (!kinds.length) return null;
	const asksJob = chosen.some((k) => !own.includes(k));
	return (
		<Stack
			gap="lg"
			className={classes.signing}
			role="group"
			aria-label={t`Signing`}
		>
			<Stack gap="sm">
				<Stack gap={4}>
					<Text size="sm">
						<Trans>Signing</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>One person signs each document.</Trans>
					</Text>
				</Stack>
				<Stack gap="xs" align="flex-start">
					{kinds.map((k) => {
						const fixed = own.includes(k);
						const pressed = fixed || chosen.includes(k);
						const now = holders[k];
						// Whom it replaces goes beside the choice, or under it if there is no room.
						return (
							<Group key={k} gap="xs">
								<Choice
									pressed={pressed}
									fixed={fixed}
									onClick={() => onToggle(k)}
									icon={<SignatureIcon size={16} aria-hidden />}
									testId={`sign-${k}`}
								>
									{signText(k)}
								</Choice>
								{now && pressed && !fixed && (
									<Text size="xs" c="dimmed" data-testid={`sign-${k}-replaces`}>
										{t`Replaces ${now}`}
									</Text>
								)}
							</Group>
						);
					})}
				</Stack>
			</Stack>
			{asksJob && (
				<TextInput
					label={t`Job title`}
					description={t`Optional. It goes on the signature.`}
					autoComplete="off"
					maxLength={200}
					value={job}
					onChange={(e) => onJob(e.currentTarget.value)}
					data-testid="person-job"
				/>
			)}
		</Stack>
	);
}
