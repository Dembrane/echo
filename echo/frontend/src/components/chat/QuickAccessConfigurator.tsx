import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Button,
	Checkbox,
	Group,
	Stack,
	Text,
} from "@mantine/core";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";
import { useState } from "react";
import type { Template } from "./templates";

export type QuickAccessItem = {
	type: "static" | "user";
	id: string;
	title: string;
};

type QuickAccessConfiguratorProps = {
	staticTemplates: Template[];
	userTemplates: Array<{ id: string; title: string }>;
	initialSelected: QuickAccessItem[];
	onSave: (items: QuickAccessItem[]) => void;
	isSaving?: boolean;
};

export const QuickAccessConfigurator = ({
	staticTemplates,
	userTemplates,
	initialSelected,
	onSave,
	isSaving = false,
}: QuickAccessConfiguratorProps) => {
	const [selected, setSelected] = useState<QuickAccessItem[]>(initialSelected);

	const allItems: QuickAccessItem[] = [
		...staticTemplates.map((t) => ({
			type: "static" as const,
			id: t.id,
			title: t.title,
		})),
		...userTemplates.map((t) => ({
			type: "user" as const,
			id: t.id,
			title: t.title,
		})),
	];

	const isSelected = (item: QuickAccessItem) =>
		selected.some((s) => s.type === item.type && s.id === item.id);

	const toggleItem = (item: QuickAccessItem) => {
		if (isSelected(item)) {
			setSelected(selected.filter((s) => !(s.type === item.type && s.id === item.id)));
		} else if (selected.length < 5) {
			setSelected([...selected, item]);
		}
	};

	const moveItem = (index: number, direction: "up" | "down") => {
		const newSelected = [...selected];
		const swapIndex = direction === "up" ? index - 1 : index + 1;
		if (swapIndex < 0 || swapIndex >= newSelected.length) return;
		[newSelected[index], newSelected[swapIndex]] = [
			newSelected[swapIndex],
			newSelected[index],
		];
		setSelected(newSelected);
	};

	return (
		<Stack gap="sm">
			<Group justify="space-between">
				<Text size="sm" fw={600}>
					<Trans>Quick Access (max 5)</Trans>
				</Text>
				<Badge size="sm" variant="light">
					{selected.length}/5
				</Badge>
			</Group>

			{/* Selected items with reorder controls */}
			{selected.length > 0 && (
				<Stack gap={4}>
					{selected.map((item, index) => (
						<Group
							key={`${item.type}-${item.id}`}
							gap="xs"
							className="rounded border border-gray-200 px-2 py-1"
						>
							<Text size="sm" className="flex-1">
								{item.title}
							</Text>
							<Badge size="xs" variant="light" color={item.type === "user" ? "blue" : "gray"}>
								{item.type === "user" ? t`Custom` : t`Built-in`}
							</Badge>
							<ActionIcon
								size="xs"
								variant="subtle"
								disabled={index === 0}
								onClick={() => moveItem(index, "up")}
							>
								<IconArrowUp size={12} />
							</ActionIcon>
							<ActionIcon
								size="xs"
								variant="subtle"
								disabled={index === selected.length - 1}
								onClick={() => moveItem(index, "down")}
							>
								<IconArrowDown size={12} />
							</ActionIcon>
						</Group>
					))}
				</Stack>
			)}

			{/* All available templates */}
			<Stack gap={4}>
				{allItems.map((item) => (
					<Checkbox
						key={`${item.type}-${item.id}`}
						label={item.title}
						checked={isSelected(item)}
						disabled={!isSelected(item) && selected.length >= 5}
						onChange={() => toggleItem(item)}
						size="sm"
					/>
				))}
			</Stack>

			<Button
				size="sm"
				onClick={() => onSave(selected)}
				loading={isSaving}
			>
				<Trans>Save Quick Access</Trans>
			</Button>
		</Stack>
	);
};
