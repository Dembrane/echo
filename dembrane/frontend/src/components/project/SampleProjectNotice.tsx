import { Trans } from "@lingui/react/macro";
import { Alert, Text } from "@mantine/core";
import { InfoIcon } from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";

// Every workspace gets a sample project (project.is_sample) to explore and ask
// questions of. Nothing in it is real, and it says so where it opens.
export const SampleProjectNotice = () => (
	<Alert
		variant="light"
		color="primary"
		icon={<InfoIcon size={16} />}
		{...testId("sample-project-notice")}
	>
		<Text size="sm">
			<Trans>
				This is a sample project. The organisations, people and conversations in
				it are invented.
			</Trans>
		</Text>
	</Alert>
);
