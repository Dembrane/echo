import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { testId } from "@/lib/testUtils";

const RULE = "var(--app-stroke) solid var(--app-rule-color)";

/**
 * What anonymising does to a transcript, on a made-up excerpt (ECHO-1060): before and
 * after, labelled as an example. Part of the Anonymise option, under its switch (ECHO-1062).
 */
export const AnonymiseExample = () => (
	<Stack gap="sm" maw={520} {...testId("portal-anonymise-example")}>
		<Text size="sm">
			<Trans>Example</Trans>
		</Text>
		<Stack gap={4} py="xs" style={{ borderTop: RULE }}>
			<Text size="sm" className="app-muted">
				<Trans>Before</Trans>
			</Text>
			<Text size="sm">
				<Trans>
					I'm Maria Jansen from Lindenstraat 12. Call me on 06 1234 5678 about
					the square.
				</Trans>
			</Text>
		</Stack>
		<Stack gap={4} py="xs" style={{ borderBottom: RULE, borderTop: RULE }}>
			<Text size="sm" className="app-muted">
				<Trans>After</Trans>
			</Text>
			<Text size="sm">
				<Trans>
					I'm [name] from [address]. Call me on [phone] about the square.
				</Trans>
			</Text>
		</Stack>
		<Text size="sm" className="app-muted">
			<Trans>
				Hosts read the after. The recording itself cannot be played or
				downloaded.
			</Trans>
		</Text>
	</Stack>
);
