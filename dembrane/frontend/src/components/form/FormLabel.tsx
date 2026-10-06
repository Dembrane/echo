import { Trans } from "@lingui/react/macro";
import { Group, Text, Tooltip } from "@mantine/core";

interface FormLabelProps {
	label: React.ReactNode;
	error?: string | boolean;
	isDirty?: boolean;
}

export const FormLabel = ({ label, isDirty, error }: FormLabelProps) => {
	return (
		<Group gap="xs" align="center">
			<Text size="sm">{label}</Text>
			{isDirty && (
				<Tooltip label={<Trans>Unsaved changes</Trans>}>
					<div
						className="h-1.5 w-1.5 rounded-full"
						style={{
							background: error ? "var(--app-danger)" : "var(--app-action)",
						}}
						role="presentation"
					/>
				</Tooltip>
			)}
		</Group>
	);
};
