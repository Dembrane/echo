import { Box, Radio, SimpleGrid, type SimpleGridProps } from "@mantine/core";
import type { ReactNode } from "react";

export interface SelectableCardOption {
	value: string;
	/** What the card shows; it gets whether it is the chosen one. */
	render: (checked: boolean) => ReactNode;
	testId?: string;
}

interface SelectableCardGridProps {
	options: readonly SelectableCardOption[];
	value: string | null;
	onChange: (value: string) => void;
	/** The id of the visible heading that names the choice. */
	labelId: string;
	/** Group name; the arrow keys move within cards that share it. */
	name: string;
	cols?: SimpleGridProps["cols"];
	testId?: string;
}

/**
 * A choice of one, drawn as cards: a radio group to a screen reader and the keyboard.
 * One tab stop (the chosen card, else the first); the arrow keys move and choose;
 * Space and Enter choose the focused card. Cards follow the "do" border grammar and the
 * chosen one takes the blue box on the action tint (.app-do[data-selected]).
 */
export const SelectableCardGrid = ({
	options,
	value,
	onChange,
	labelId,
	name,
	cols = { base: 1, sm: 2 },
	testId,
}: SelectableCardGridProps) => {
	const focusable = options.some((o) => o.value === value)
		? value
		: (options[0]?.value ?? null);
	return (
		<Radio.Group
			value={value ?? ""}
			onChange={onChange}
			name={name}
			labelProps={{ id: labelId }}
			{...(testId ? { "data-testid": testId } : {})}
		>
			<SimpleGrid cols={cols} spacing="sm">
				{options.map((option) => {
					const checked = option.value === value;
					return (
						<Radio.Card
							key={option.value}
							value={option.value}
							className="app-do"
							p="md"
							// A button centres its content; cards of unequal length read from the top.
							style={{ alignItems: "flex-start", display: "flex" }}
							tabIndex={option.value === focusable ? 0 : -1}
							{...(checked ? { "data-selected": true } : {})}
							{...(option.testId ? { "data-testid": option.testId } : {})}
						>
							<Box w="100%">{option.render(checked)}</Box>
						</Radio.Card>
					);
				})}
			</SimpleGrid>
		</Radio.Group>
	);
};
