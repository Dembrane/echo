import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Stack, Text } from "@mantine/core";
import { PlayIcon } from "@phosphor-icons/react";
import { presentErrorNow } from "@/lib/errors/present";
import { testId } from "@/lib/testUtils";
import type { TrySection } from "./tryIt";
import type { TryStatus } from "./useTryIt";

interface TryItActionProps {
	section: TrySection;
	status: TryStatus;
	/** A result is shown in the preview. */
	hasResult: boolean;
	/** That result was made with other settings than the page has now. */
	stale: boolean;
	/** Why the last try failed, when it did. */
	error: unknown;
	/** Nothing to try yet (Verify with no topic chosen). */
	unavailable: boolean;
	/** Explore may look at other conversations, which one sample cannot show. */
	crossPollination: boolean;
	onTry: () => void;
}

/**
 * "Try it" beside the preview (ECHO-1061): one button and a line on where things stand.
 * The phone shows the result; this says what it is made from. Props in, callbacks out.
 */
export const TryItAction = ({
	section,
	status,
	hasResult,
	stale,
	error,
	unavailable,
	crossPollination,
	onTry,
}: TryItActionProps) => {
	const { i18n } = useLingui();
	const running = status === "running";
	const again = hasResult || status === "failed";

	let line: React.ReactNode;
	if (running)
		line = <Trans>Running your settings on a sample conversation…</Trans>;
	else if (status === "limit")
		line = (
			<Trans>You have used every try for this hour. Try again later.</Trans>
		);
	else if (status === "failed") line = presentErrorNow(error, i18n).message;
	else if (unavailable) line = <Trans>Choose a topic first.</Trans>;
	else if (stale)
		line = (
			<Trans>
				Your settings changed. The preview shows the result of the earlier ones.
			</Trans>
		);
	else if (hasResult)
		line = <Trans>The preview shows the result for your settings.</Trans>;
	else if (section === "explore")
		line = (
			<Trans>
				See the question your settings give, on a short sample conversation.
			</Trans>
		);
	else
		line = (
			<Trans>
				See the draft your settings give, on a short sample conversation.
			</Trans>
		);

	return (
		<Stack gap="xs" maw={360} {...testId("portal-try")} data-status={status}>
			<Box>
				<Button
					variant="outline"
					size="sm"
					leftSection={<PlayIcon size={16} />}
					loading={running}
					disabled={unavailable || status === "limit"}
					onClick={onTry}
					{...testId("portal-try-button")}
				>
					{again ? <Trans>Try again</Trans> : <Trans>Try it</Trans>}
				</Button>
			</Box>
			<Text
				size="sm"
				role="status"
				style={status === "failed" ? { color: "var(--app-danger)" } : undefined}
				className={status === "failed" ? undefined : "app-muted"}
				{...testId("portal-try-status")}
			>
				{line}
			</Text>
			{section === "explore" && crossPollination && (
				<Text size="sm" className="app-muted" {...testId("portal-try-others")}>
					<Trans>
						One sample cannot show what Explore takes from other conversations.
					</Trans>
				</Text>
			)}
		</Stack>
	);
};
