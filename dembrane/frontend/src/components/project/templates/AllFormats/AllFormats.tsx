import { SimpleGrid, Skeleton } from "@mantine/core";
import { useState } from "react";
import {
	type ChoiceKey,
	cardFacts,
	NO_FILTER,
	offeredCards,
	type TemplateChoiceContext,
	type TemplateFilter,
	type TemplateSummary,
	visibleCards,
} from "../projectTemplates";
import { TemplateCardButton } from "../TemplateCard/TemplateCardButton";
import { TemplateChooser } from "../TemplateChooser/TemplateChooser";
import { TemplateFilters } from "../TemplateFilters/TemplateFilters";

interface AllFormatsProps {
	/** From GET /v2/project-templates; undefined while it loads. */
	templates: readonly TemplateSummary[] | undefined;
	failed?: boolean;
	/** A card was pressed: the flow moves on with it. */
	onChoose: (key: ChoiceKey, context: TemplateChoiceContext) => void;
	onFilterChange?: (filter: "verb" | "setup", value: string) => void;
	onUpload: () => void;
}

const activeFilters = (f: TemplateFilter): string[] => [
	...(f.verb ? [`verb:${f.verb}`] : []),
	...(f.setup ? [`setup:${f.setup}`] : []),
];

/**
 * "All formats" (ECHO-1058), for a host who skipped the upload and the row: the filters
 * first, then Quick start and every template as a card. A filter shows only the formats
 * that match, or Quick start alone when none do (offeredCards). Pressing a card chooses it
 * and moves on. Under the grid, the quiet way out: upload recordings. Props in, callbacks
 * out.
 */
export const AllFormats = ({
	templates,
	failed = false,
	onChoose,
	onFilterChange,
	onUpload,
}: AllFormatsProps) => {
	const [filter, setFilter] = useState<TemplateFilter>(NO_FILTER);
	const formats = templates && !failed ? visibleCards(templates, filter) : [];
	const { cards, count } = offeredCards(formats, filter);

	return (
		<TemplateChooser
			templates={templates}
			failed={failed}
			skeleton={
				<>
					<Skeleton height={40} />
					<Skeleton height={240} />
				</>
			}
			filters={
				<TemplateFilters
					value={filter}
					count={count}
					onChange={(next, changed) => {
						setFilter(next);
						onFilterChange?.(changed, next[changed] ?? "none");
					}}
				/>
			}
			empty={formats.length === 0}
			onUpload={onUpload}
			testId="all-formats"
		>
			<SimpleGrid
				cols={{ base: 1, lg: 4, md: 3, sm: 2 }}
				spacing="sm"
				data-testid="all-formats-grid"
			>
				{cards.map((tpl) => (
					<TemplateCardButton
						key={tpl.key}
						template={tpl}
						onChoose={() =>
							onChoose(tpl.key, {
								...cardFacts(tpl),
								filtersActive: activeFilters(filter),
								list: "all_formats",
							})
						}
					/>
				))}
			</SimpleGrid>
		</TemplateChooser>
	);
};
