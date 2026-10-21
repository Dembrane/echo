import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { testId } from "@/lib/testUtils";

/** Neutral portal notice; never mentions plans, limits or upgrades. */
export const NotTakingRecordings = () => (
	<Stack
		align="center"
		justify="center"
		p="xl"
		{...testId("portal-not-taking-recordings")}
	>
		<Text size="lg" ta="center">
			<Trans id="participant.not_taking_recordings">
				This project isn't taking recordings right now.
			</Trans>
		</Text>
	</Stack>
);
