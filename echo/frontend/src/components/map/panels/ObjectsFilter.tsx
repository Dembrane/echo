import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Checkbox, Popover, Stack, Text } from "@mantine/core";
import { OBJECT_TYPE_STYLES, OBJECT_TYPES } from "../attributes";
import type { ObjectType } from "../types";
import { CaptionText, TypeDot } from "./shared";

export type ObjectsFilterListProps = {
	/** Saved objects per type, before filtering. */
	counts: Record<ObjectType, number>;
	selected: ReadonlyArray<ObjectType>;
	onChange: (types: ObjectType[]) => void;
	/**
	 * Starts the recipe that creates a type. Only an explicit click calls it;
	 * a filter change never starts generation.
	 */
	onGenerate?: (type: ObjectType) => void;
	/** Types whose generation this host may start. */
	canGenerate?: (type: ObjectType) => boolean;
};

/** One checkbox per object type with its count. */
export const ObjectsFilterList = ({
	counts,
	selected,
	onChange,
	onGenerate,
	canGenerate,
}: ObjectsFilterListProps) => (
	<Stack gap="xs">
		{OBJECT_TYPES.map((type) => {
			const style = OBJECT_TYPE_STYLES[type];
			const checked = selected.includes(type);
			const count = counts[type] ?? 0;
			const toggle = (next: boolean) =>
				onChange(
					OBJECT_TYPES.filter((item) =>
						item === type ? next : selected.includes(item),
					),
				);
			return (
				<div key={type} className="space-y-1">
					<Checkbox
						size="sm"
						checked={checked}
						onChange={(event) => toggle(event.currentTarget.checked)}
						label={
							<span className="flex items-center gap-2">
								<TypeDot type={type} />
								<span>{style.pluralLabel()}</span>
								<span className="text-xs">{count}</span>
							</span>
						}
					/>
					{checked && count === 0 && (
						<div className="ml-7 space-y-1">
							<CaptionText>{style.emptyLabel()}</CaptionText>
							{onGenerate && (canGenerate?.(type) ?? true) && (
								<Button
									size="compact-xs"
									variant="outline"
									onClick={() => onGenerate(type)}
								>
									{style.generateLabel()}
								</Button>
							)}
						</div>
					)}
				</div>
			);
		})}
	</Stack>
);

/** The Objects filter in the page header. */
export const ObjectsFilter = (
	props: ObjectsFilterListProps & { visibleCount: number },
) => {
	const { visibleCount, ...listProps } = props;
	return (
		<Popover position="bottom-end" shadow="xl" width={300} withinPortal>
			<Popover.Target>
				<Button variant="outline" size="sm" aria-label={t`Objects`}>
					<Trans>Objects ({visibleCount})</Trans>
				</Button>
			</Popover.Target>
			<Popover.Dropdown>
				<Stack gap="sm">
					<Text size="sm" fw={600}>
						<Trans>Objects</Trans>
					</Text>
					<ObjectsFilterList {...listProps} />
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
};
