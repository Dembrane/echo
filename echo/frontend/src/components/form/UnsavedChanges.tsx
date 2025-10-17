import { Trans } from "@lingui/react/macro";
import { Group, Text, Tooltip } from "@mantine/core";
import { formatRelative } from "date-fns";
import { LoadingSpinner } from "../common/LoadingSpinner";

export const UnsavedChanges = ({
	isSaving,
	lastSavedAt,
}: {
	isDirty?: boolean;
	isSaving?: boolean;
	lastSavedAt?: Date;
}) => {
	return (
		<Group gap="md">
			<Text size="xs" c="gray">
				{lastSavedAt ? (
					<Trans>Last saved {formatRelative(lastSavedAt, new Date())}</Trans>
				) : (
					<Trans>Changes will be saved automatically</Trans>
				)}
			</Text>
			{isSaving && <LoadingSpinner />}
		</Group>
	);
};
