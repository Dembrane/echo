import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { testId } from "@/lib/testUtils";

/** Neutral portal notice; never mentions plans, limits or upgrades. Text mode says responses. */
export const NotTakingRecordings = ({ text = false }: { text?: boolean }) => (
	<Stack
		align="center"
		justify="center"
		p="xl"
		{...testId("portal-not-taking-recordings")}
	>
		<Text size="lg" ta="center">
			{text ? (
				<Trans id="participant.not_taking_responses">
					This project isn't taking responses right now.
				</Trans>
			) : (
				<Trans id="participant.not_taking_recordings">
					This project isn't taking recordings right now.
				</Trans>
			)}
		</Text>
	</Stack>
);
