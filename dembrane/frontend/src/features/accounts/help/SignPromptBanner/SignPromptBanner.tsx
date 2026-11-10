import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Text } from "@mantine/core";
import { ListChecksIcon } from "@phosphor-icons/react";

export interface SignPromptBannerProps {
	/** The organisation the tasks are in. */
	orgName: string;
	/** How many tasks wait on the viewer there. */
	tasksWaiting: number;
	/** The next task, already worded; null when there is none to name. */
	nextTask: string | null;
	/** "Go to your tasks". */
	onOpen: () => void;
	/** The close button: hides it for the rest of this browser session. */
	onDismiss: () => void;
}

/**
 * One slim line at the top of the page for someone with tasks waiting on them (most
 * often an offer to sign): how many, where, the next one, a way there and a way to
 * close it. A block: props in, callbacks out, no data of its own. It reads as an Alert,
 * so it takes the rule above and below.
 */
export function SignPromptBanner(props: SignPromptBannerProps) {
	const { onOpen, onDismiss } = props;
	// The same words the popup used, so every language already has them.
	const name = props.orgName;
	const next = props.nextTask;
	const count = plural(props.tasksWaiting, {
		one: `You have # thing to do in ${name}`,
		other: `You have # things to do in ${name}`,
	});
	return (
		<Alert
			color="primary"
			py={8}
			icon={<ListChecksIcon size={20} />}
			withCloseButton
			closeButtonLabel={t`Close`}
			onClose={onDismiss}
			data-testid="sign-prompt-banner"
		>
			<Group gap="sm" wrap="wrap" align="center" justify="space-between">
				<Text size="sm" style={{ flex: "1 1 16rem" }}>
					{count}
					{next && (
						<>
							{". "}
							<Trans>Next: {next}</Trans>
						</>
					)}
				</Text>
				<Button
					variant="outline"
					size="xs"
					onClick={onOpen}
					data-testid="sign-prompt-open"
				>
					<Trans>Go to your tasks</Trans>
				</Button>
			</Group>
		</Alert>
	);
}
