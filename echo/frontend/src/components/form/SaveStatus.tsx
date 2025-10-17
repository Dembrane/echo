import { Trans } from "@lingui/react/macro";
import { Group, Text } from "@mantine/core";
import {
	IconCheck,
	IconChecks,
	IconExclamationCircle,
	IconX,
} from "@tabler/icons-react";
import { formatDistance } from "date-fns";
import type { FieldErrors } from "react-hook-form";
import { LoadingSpinner } from "../common/LoadingSpinner";

type SaveStatusProps = {
	savedAt: Date | null;
	isPendingSave: boolean;
	isSaving: boolean;
	formErrors: FieldErrors;
	isError: boolean;
};

export const SaveStatus = ({
	savedAt,
	isPendingSave,
	formErrors,
	isSaving,
	isError,
}: SaveStatusProps) => {
	if (isError) {
		return (
			<StatusIcon icon={IconX}>
				<Trans>Save Error!</Trans>
			</StatusIcon>
		);
	}

	if (Object.keys(formErrors).length > 0) {
		return (
			<StatusIcon icon={IconExclamationCircle}>
				<Trans>Please check your inputs for errors.</Trans>
			</StatusIcon>
		);
	}

	if (isSaving) {
		return (
			<StatusIcon icon={LoadingSpinner}>
				<Trans>Saving...</Trans>
			</StatusIcon>
		);
	}

	if (!savedAt || isPendingSave) {
		return (
			<StatusIcon icon={IconCheck}>
				<Trans>Your inputs will be saved automatically.</Trans>
			</StatusIcon>
		);
	}

	return (
		<StatusIcon icon={IconChecks}>
			<Trans>
				Last saved{" "}
				{formatDistance(new Date(savedAt), new Date(), { addSuffix: true })}
			</Trans>
		</StatusIcon>
	);
};

const StatusIcon = ({
	icon: Icon,
	children,
}: {
	icon: React.ElementType;
	children: React.ReactNode;
}) => {
	return (
		<Group gap="xs" align="center">
			<Icon size={16} />
			<Text size="sm">{children}</Text>
		</Group>
	);
};
