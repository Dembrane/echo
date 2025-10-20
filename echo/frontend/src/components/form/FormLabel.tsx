import { Trans } from "@lingui/react/macro";
import { Group, Text, Tooltip } from "@mantine/core";
import { cn } from "@/lib/utils";

interface FormLabelProps {
	label: React.ReactNode;
	error?: string | boolean;
	isDirty?: boolean;
}

export const FormLabel = ({ label, isDirty, error }: FormLabelProps) => {
	return (
		<Group gap="xs" align="center">
			<Text size="sm" fw={500}>
				{label}
			</Text>
			{isDirty && (
				<Tooltip label={<Trans>Unsaved changes</Trans>}>
					<div
						className={cn(
							"h-1.5 w-1.5 rounded-full",
							error ? "bg-red-500" : "bg-blue-500",
						)}
						role="presentation"
					/>
				</Tooltip>
			)}
		</Group>
	);
};
