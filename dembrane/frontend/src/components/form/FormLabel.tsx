import { Trans } from "@lingui/react/macro";
import { Group, Text, Tooltip, VisuallyHidden } from "@mantine/core";
import { createContext, useContext } from "react";

interface FormLabelProps {
	label: React.ReactNode;
	error?: string | boolean;
	isDirty?: boolean;
}

/**
 * The name already shown above a field, when there is one: the portal editor's option
 * stepper puts the open option's title here (ECHO-1060). A label with the same words is
 * then read out, but not shown a second time.
 */
export const ShownTitleContext = createContext<string | null>(null);

export const FormLabel = ({ label, isDirty, error }: FormLabelProps) => {
	const shownTitle = useContext(ShownTitleContext);
	const repeatsTitle = typeof label === "string" && label === shownTitle;
	return (
		<Group gap="xs" align="center">
			{repeatsTitle ? (
				<VisuallyHidden>{label}</VisuallyHidden>
			) : (
				<Text size="sm">{label}</Text>
			)}
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
