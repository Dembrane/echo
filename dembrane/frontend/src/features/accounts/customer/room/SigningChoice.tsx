import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Group, Stack, Text, TextInput } from "@mantine/core";
import { SignatureIcon } from "@phosphor-icons/react";
import { signText } from "./copy";
import type { SignKind } from "./model";
import classes from "./SigningChoice.module.css";
import tags from "./Tags.module.css";

/**
 * Who signs, set in the same flow as what someone does, and kept apart from it: under a
 * rule, as the signing markers themselves (outlined blue, the pen), never as label boxes.
 * One person signs each document, so each says who signs it now. The job title goes on
 * the signature, so it is asked only once a signing duty is chosen.
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
			gap="sm"
			className={classes.signing}
			role="group"
			aria-label={t`Signing`}
		>
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
					return (
						<Group key={k} gap="sm" wrap="nowrap">
							<Badge
								component="button"
								type="button"
								variant="outline"
								className={`${tags.tag} ${tags.sign}`}
								data-sign={k}
								data-selected={pressed || undefined}
								aria-pressed={pressed}
								aria-disabled={fixed || undefined}
								leftSection={<SignatureIcon size={16} aria-hidden />}
								onClick={() => !fixed && onToggle(k)}
								data-testid={`sign-${k}`}
							>
								{signText(k)}
							</Badge>
							{now && !fixed && (
								<Text size="xs" c="dimmed">
									{t`Now: ${now}`}
								</Text>
							)}
						</Group>
					);
				})}
			</Stack>
			{asksJob && (
				<TextInput
					label={t`Their job title`}
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
