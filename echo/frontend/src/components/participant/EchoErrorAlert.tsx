import { Trans } from "@lingui/react/macro";
import { Alert, Text } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

export const EchoErrorAlert = () => {
  return (
    <Alert
      icon={<IconAlertCircle size="1rem" />}
      color="red"
      variant="outline"
      className="my-5 md:my-7"
    >
      <Text>
        <Trans id="participant.echo.error.message">
          Something went wrong. Please try again by pressing the{" "}
          <span className="font-bold">ECHO</span> button, or contact support if
          the issue continues.
        </Trans>
      </Text>
    </Alert>
  );
};
