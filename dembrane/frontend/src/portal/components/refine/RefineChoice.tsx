import { Group, Progress, Stack, Text, UnstyledButton } from "@mantine/core";
import { CaretRightIcon, type Icon } from "@phosphor-icons/react";
import { type ReactNode, useId } from "react";
import { AiUnavailableText } from "@/portal/components/AiUnavailable";

/**
 * One pressable choice on a phone (ECHO-1052): the full box that means "do", in the
 * control grey so it reads as a button at a glance, an icon, a label, one line on what
 * happens, and a caret. At least 44px tall; the label is its accessible name and the line
 * its description. A locked choice says why and does nothing when pressed.
 */
export const RefineChoice = ({
	icon: IconComponent,
	label,
	description,
	onPress,
	locked,
	aiUnavailable,
	cooldown,
	testId,
}: {
	icon: Icon;
	label: ReactNode;
	description: ReactNode;
	onPress: () => void;
	locked: boolean;
	aiUnavailable: boolean;
	cooldown: { isActive: boolean; progress: number; text: ReactNode };
	testId: string;
}) => {
	const labelId = useId();
	const descriptionId = useId();
	return (
		<UnstyledButton
			onClick={() => {
				if (!locked) onPress();
			}}
			className="app-do app-choice block w-full px-5 py-5"
			aria-disabled={locked || undefined}
			aria-labelledby={labelId}
			aria-describedby={descriptionId}
			data-testid={testId}
		>
			<Group gap="md" wrap="nowrap" align="center">
				<IconComponent size={28} aria-hidden="true" />
				<Stack gap="xs" className="min-w-0 flex-1">
					<Text id={labelId} size="lg">
						{label}
					</Text>
					<Text id={descriptionId} size="sm" c="dimmed">
						{description}
					</Text>
					{aiUnavailable && <AiUnavailableText />}
					{!aiUnavailable && cooldown.isActive && (
						<Stack gap="xs" w="100%">
							<Text size="sm" c="dimmed">
								{cooldown.text}
							</Text>
							<Progress value={cooldown.progress} size="md" animated />
						</Stack>
					)}
				</Stack>
				<CaretRightIcon size={20} aria-hidden="true" />
			</Group>
		</UnstyledButton>
	);
};
