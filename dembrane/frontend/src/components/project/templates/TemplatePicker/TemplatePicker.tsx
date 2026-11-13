import { Skeleton } from "@mantine/core";
import { useId, useState } from "react";
import { SelectableCardGrid } from "@/components/common/SelectableCardGrid/SelectableCardGrid";
import {
	type CardKey,
	cardTags,
	isCardKey,
	NO_FILTER,
	type TemplateFilter,
	type TemplateKey,
	type TemplateSummary,
	templateGreatFor,
	templateName,
	visibleCards,
} from "../projectTemplates";
import { TemplateCard } from "../TemplateCard/TemplateCard";
import { TemplateChooser } from "../TemplateChooser/TemplateChooser";
import { TemplateFilters } from "../TemplateFilters/TemplateFilters";

/** What the picker knew when a card was chosen, for analytics: never free text. */
export interface TemplateChoiceContext {
	featured: boolean;
	verbs: string[];
	setup: string;
	/** "verb:<verb>", "setup:<setup>" or "show_all"; empty in the first view. */
	filtersActive: string[];
	/** Where the card was pressed: the start screen's row, all formats, or the old picker. */
	list?: "row" | "all_formats" | "picker";
}

interface TemplatePickerProps {
	/** From GET /v2/project-templates; undefined while it loads. */
	templates: readonly TemplateSummary[] | undefined;
	/** The list could not load: the cards are left out and blank stays possible. */
	failed?: boolean;
	value: TemplateKey | null;
	onChange: (key: CardKey, context: TemplateChoiceContext) => void;
	/** A filter changed: which one, and its new value ("none" when cleared). */
	onFilterChange?: (
		filter: "verb" | "setup" | "show_all",
		value: string,
	) => void;
	/** The quiet links under the cards. Each is hidden when not given. */
	onStartBlank?: () => void;
	onUpload?: () => void;
	/** Heading level: a step of a page is a 4, a group inside a section a 5. */
	order?: 4 | 5;
}

const activeFilters = (f: TemplateFilter, showAll: boolean): string[] => [
	...(f.verb ? [`verb:${f.verb}`] : []),
	...(f.setup ? [`setup:${f.setup}`] : []),
	...(showAll && !f.verb && !f.setup ? ["show_all"] : []),
];

/**
 * "What are you going to do?" (ECHO-1053): templates by purpose. The first view is the
 * short "most used" set; the filters (what you need to do, how it is recorded) and "Show
 * all" reveal the rest. Cards are a radio group; "Upload recordings" and "Start blank" are
 * quiet links under them. Props in, callbacks out; TemplatePickerConnected fetches.
 */
export const TemplatePicker = ({
	templates,
	failed = false,
	value,
	onChange,
	onFilterChange,
	onStartBlank,
	onUpload,
	order = 4,
}: TemplatePickerProps) => {
	const headingId = useId();
	const [filter, setFilter] = useState<TemplateFilter>(NO_FILTER);
	const [showAll, setShowAll] = useState(false);
	const cards = templates ? visibleCards(templates, filter, showAll) : [];

	return (
		<TemplateChooser
			templates={templates}
			failed={failed}
			order={order}
			headingId={headingId}
			skeleton={[0, 1, 2].map((i) => <Skeleton key={i} height={132} />)}
			filters={
				<TemplateFilters
					value={filter}
					count={cards.length}
					onChange={(next, changed) => {
						setFilter(next);
						onFilterChange?.(changed, next[changed] ?? "none");
					}}
					showAll={{
						on: showAll,
						onChange: (next) => {
							setFilter(NO_FILTER);
							setShowAll(next);
							onFilterChange?.("show_all", next ? "on" : "off");
						},
					}}
				/>
			}
			empty={cards.length === 0}
			onUpload={onUpload}
			onStartBlank={onStartBlank}
			gap="md"
			testId="template-picker"
			tour="template-picker"
		>
			<SelectableCardGrid
				labelId={headingId}
				name="project-template"
				value={value}
				onChange={(key) => {
					const tpl = cards.find((c) => c.key === key);
					if (!tpl || !isCardKey(key)) return;
					onChange(key, {
						featured: tpl.card.featured,
						filtersActive: activeFilters(filter, showAll),
						setup: tpl.card.setup,
						verbs: tpl.card.verbs,
					});
				}}
				testId="template-picker-grid"
				options={cards.map((tpl) => {
					const key = tpl.key as CardKey;
					return {
						render: () => (
							<TemplateCard
								template={key}
								name={templateName(key)}
								greatFor={templateGreatFor(key)}
								tags={cardTags(tpl)}
							/>
						),
						testId: `template-card-${key}`,
						value: key,
					};
				})}
			/>
		</TemplateChooser>
	);
};
