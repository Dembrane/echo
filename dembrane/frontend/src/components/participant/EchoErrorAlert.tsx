import { Trans } from "@lingui/react/macro";
import { Alert, Text } from "@mantine/core";
import { WarningCircleIcon } from "@phosphor-icons/react";

export const EchoErrorAlert = ({ error }: { error: Error }) => {
	return (
		<Alert
			icon={<WarningCircleIcon size={20} />}
			color="red"
			className="my-5 md:my-7"
		>
			<Text size="sm">
				{error?.message?.includes("CONTENT_POLICY_VIOLATION") ? (
					<Trans id="participant.go.deeper.content.policy.violation.error.message">
						Sorry, we cannot process this request due to an LLM provider's
						content policy.
					</Trans>
				) : (
					<Trans id="participant.explore.generic.error.message">
						Something went wrong. Please try again by pressing the{" "}
						<strong>Explore</strong> button, or contact support if the issue
						continues.
					</Trans>
				)}
			</Text>
		</Alert>
	);
};
