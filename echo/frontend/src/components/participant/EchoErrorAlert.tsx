import { Trans } from "@lingui/react/macro";
import { Alert, Text } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

export const EchoErrorAlert = ({ error }: { error: Error }) => {
	return (
		<Alert
			icon={<IconAlertCircle size="1rem" />}
			color="red"
			variant="outline"
			radius="md"
			className="my-5 md:my-7"
		>
			<Text size="sm">
				{error?.message?.includes("CONTENT_POLICY_VIOLATION") ? (
					<Trans id="participant.go.deeper.content.policy.violation.error.message">
						Sorry, we cannot process this request due to an LLM provider's
						content policy.
					</Trans>
				) : (
					<Trans id="participant.go.deeper.generic.error.message">
						Something went wrong. Please try again by pressing the{" "}
						<span className="font-bold">Go deeper</span> button, or contact
						support if the issue continues.
					</Trans>
				)}
			</Text>
		</Alert>
	);
};
