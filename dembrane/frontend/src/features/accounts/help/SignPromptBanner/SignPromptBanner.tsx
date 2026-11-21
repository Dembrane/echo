import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, CloseButton, Group, Paper, Text } from "@mantine/core";
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
 * close it. A block: props in, callbacks out, no data of its own. Something to read, so
 * a Paper with the rule above and below and the action tint an Alert has. Not an Alert:
 * Mantine fixes that to role="alert", which a screen reader would announce on every page;
 * a labelled region is found when wanted and stays quiet otherwise.
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
		<Paper
			component="section"
			role="region"
			aria-label={t`Tasks`}
			withBorder
			radius={0}
			px="md"
			py="xs"
			bg="var(--app-action-tint)"
			data-testid="sign-prompt-banner"
		>
			<Group gap="sm" wrap="nowrap" align="center">
				<ListChecksIcon
					size={20}
					color="var(--app-action)"
					aria-hidden
					style={{ flexShrink: 0 }}
				/>
				<Group
					gap="sm"
					wrap="wrap"
					align="center"
					justify="space-between"
					style={{ flex: 1, minWidth: 0 }}
				>
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
				<CloseButton
					aria-label={t`Close`}
					onClick={onDismiss}
					data-testid="sign-prompt-close"
				/>
			</Group>
		</Paper>
	);
}
