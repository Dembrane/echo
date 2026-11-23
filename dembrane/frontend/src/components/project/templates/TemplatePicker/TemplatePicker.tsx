import { Skeleton } from "@mantine/core";
import { useId, useState } from "react";
import { SelectableCardGrid } from "@/components/common/SelectableCardGrid/SelectableCardGrid";
import {
	type ChoiceKey,
	cardFacts,
	cardLine,
	cardTags,
	isChoiceKey,
	NO_FILTER,
	offeredCards,
	type TemplateFilter,
	type TemplateKey,
	type TemplateSummary,
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
	/** Null for Quick start, which sets nothing up. */
	setup: string | null;
	/** "verb:<verb>", "setup:<setup>" or "show_all"; empty in the first view. */
	filtersActive: string[];
	/** Where the card was pressed: the start screen's row, all formats, or the old picker. */
	list?: "row" | "all_formats" | "picker";
}

interface TemplatePickerProps {
	/** From GET /v2/project-templates; undefined while it loads. */
	templates: readonly TemplateSummary[] | undefined;
	/** The list could not load: the formats are left out and Quick start stays. */
	failed?: boolean;
	value: TemplateKey | null;
	onChange: (key: ChoiceKey, context: TemplateChoiceContext) => void;
	/** A filter changed: which one, and its new value ("none" when cleared). */
	onFilterChange?: (
		filter: "verb" | "setup" | "show_all",
		value: string,
	) => void;
	/** The quiet link under the cards, hidden when not given. */
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
 * "What are you going to do?" (ECHO-1053): templates by purpose. The first view is Quick
 * start and the short "most used" set; the filters (what you need to do, how it is
 * recorded) and "Show all" reveal the rest. A filter shows only the formats that match, or
 * Quick start alone when none do (offeredCards). Cards are a radio group; "Upload
 * recordings" is a quiet link under them. Props in, callbacks out;
 * TemplatePickerConnected fetches.
 */
export const TemplatePicker = ({
	templates,
	failed = false,
	value,
	onChange,
	onFilterChange,
	onUpload,
	order = 4,
}: TemplatePickerProps) => {
	const headingId = useId();
	const [filter, setFilter] = useState<TemplateFilter>(NO_FILTER);
	const [showAll, setShowAll] = useState(false);
	const formats =
		templates && !failed ? visibleCards(templates, filter, showAll) : [];
	const { cards, count } = offeredCards(formats, filter);

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
					count={count}
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
			empty={formats.length === 0}
			onUpload={onUpload}
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
					if (!tpl || !isChoiceKey(key)) return;
					onChange(key, {
						...cardFacts(tpl),
						filtersActive: activeFilters(filter, showAll),
					});
				}}
				testId="template-picker-grid"
				options={cards.map((tpl) => ({
					render: () => (
						<TemplateCard
							template={tpl.key}
							name={templateName(tpl.key)}
							greatFor={cardLine(tpl.key)}
							tags={cardTags(tpl)}
						/>
					),
					testId: `template-card-${tpl.key}`,
					value: tpl.key,
				}))}
			/>
		</TemplateChooser>
	);
};
