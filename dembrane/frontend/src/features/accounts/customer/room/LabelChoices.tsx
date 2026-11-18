import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Group, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import type { ReactNode } from "react";
import type { RoomLabelT } from "../../contract/contract.gen";
import { labelText } from "./copy";
import classes from "./LabelChoices.module.css";
import { inLabelOrder, ROOM_LABELS } from "./model";

export interface LabelValue {
	labels: RoomLabelT[];
	/** Null while Other is not chosen; a string (maybe empty) once it is. */
	other: string | null;
}

/**
 * What someone does in the decision: the six labels and Other, any number, one tap each,
 * none at all keeping them informed. Each is the grammar's free-standing choice
 * (`app-do app-choice`, rules.css) at the compact height, chosen drawn as the blue box on
 * the action tint. Other opens a field for their own words. Used by adding someone,
 * changing what they do and the first-visit question.
 */
export function LabelChoices({
	value,
	onChange,
	question,
	hint = "them",
}: {
	value: LabelValue;
	onChange: (v: LabelValue) => void;
	/** The question above the choices, naming the person; null where it was just asked. */
	question: ReactNode;
	/** The optional-ness line under the question, about them or about you. */
	hint?: "them" | "you" | null;
}) {
	const toggle = (l: RoomLabelT) =>
		onChange({
			...value,
			labels: inLabelOrder(
				value.labels.includes(l)
					? value.labels.filter((x) => x !== l)
					: [...value.labels, l],
			),
		});
	return (
		<Stack gap="sm">
			<Stack gap={4}>
				{question && <Text size="sm">{question}</Text>}
				{hint === "them" && (
					<Text size="xs" c="dimmed">
						<Trans>
							Optional. With nothing chosen, they are kept informed.
						</Trans>
					</Text>
				)}
				{hint === "you" && (
					<Text size="xs" c="dimmed">
						<Trans>Optional. With nothing chosen, you are kept informed.</Trans>
					</Text>
				)}
			</Stack>
			<Group gap="xs" role="group" data-testid="label-picker">
				{ROOM_LABELS.map((l) => (
					<Choice
						key={l}
						pressed={value.labels.includes(l)}
						onClick={() => toggle(l)}
						testId={`label-${l}`}
					>
						{labelText(l)}
					</Choice>
				))}
				<Choice
					pressed={value.other !== null}
					onClick={() =>
						onChange({ ...value, other: value.other === null ? "" : null })
					}
					testId="label-other"
				>
					<Trans>Other</Trans>
				</Choice>
			</Group>
			{value.other !== null && (
				<TextInput
					label={t`In your own words`}
					autoComplete="off"
					maxLength={80}
					data-autofocus
					value={value.other}
					onChange={(e) => onChange({ ...value, other: e.currentTarget.value })}
					data-testid="label-other-text"
				/>
			)}
		</Stack>
	);
}

/**
 * One option to tap (the grammar's `app-do app-choice`): the control grey outline, chosen
 * the blue box on the action tint. No check mark, so an option keeps its width when
 * chosen. An icon, when given, leads the words. `fixed` shows it chosen and unchangeable.
 */
export function Choice({
	pressed,
	onClick,
	children,
	testId,
	icon,
	fixed = false,
}: {
	pressed: boolean;
	onClick: () => void;
	children: ReactNode;
	testId: string;
	icon?: ReactNode;
	fixed?: boolean;
}) {
	return (
		<UnstyledButton
			className={`app-do app-choice ${classes.choice}`}
			data-density="compact"
			aria-pressed={pressed}
			aria-disabled={fixed || undefined}
			data-selected={pressed || undefined}
			onClick={fixed ? undefined : onClick}
			px="sm"
			py={4}
			data-testid={testId}
		>
			{icon}
			<Text size="sm" span>
				{children}
			</Text>
		</UnstyledButton>
	);
}
