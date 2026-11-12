import { SimpleGrid, Skeleton } from "@mantine/core";
import { useState } from "react";
import {
	type CardKey,
	NO_FILTER,
	type TemplateFilter,
	type TemplateSummary,
	visibleCards,
} from "../projectTemplates";
import { TemplateCardButton } from "../TemplateCard/TemplateCardButton";
import { TemplateChooser } from "../TemplateChooser/TemplateChooser";
import { TemplateFilters } from "../TemplateFilters/TemplateFilters";
import type { TemplateChoiceContext } from "../TemplatePicker/TemplatePicker";

interface AllFormatsProps {
	/** From GET /v2/project-templates; undefined while it loads. */
	templates: readonly TemplateSummary[] | undefined;
	failed?: boolean;
	/** A card was pressed: the flow moves on with it. */
	onChoose: (key: CardKey, context: TemplateChoiceContext) => void;
	onFilterChange?: (filter: "verb" | "setup", value: string) => void;
	onUpload: () => void;
	onStartBlank: () => void;
}

const activeFilters = (f: TemplateFilter): string[] => [
	...(f.verb ? [`verb:${f.verb}`] : []),
	...(f.setup ? [`setup:${f.setup}`] : []),
];

/**
 * "All formats" (ECHO-1058), for a host who skipped the upload and the row: the filters
 * first, then every template as a card. Pressing a card chooses it and moves on. Under the
 * grid, the quiet ways out: upload recordings, or start blank. Props in, callbacks out.
 */
export const AllFormats = ({
	templates,
	failed = false,
	onChoose,
	onFilterChange,
	onUpload,
	onStartBlank,
}: AllFormatsProps) => {
	const [filter, setFilter] = useState<TemplateFilter>(NO_FILTER);
	const cards = (
		templates ? visibleCards(templates, filter, true) : []
	) as (TemplateSummary & {
		key: CardKey;
	})[];

	return (
		<TemplateChooser
			templates={templates}
			failed={failed}
			order={5}
			skeleton={
				<>
					<Skeleton height={40} />
					<Skeleton height={240} />
				</>
			}
			filters={
				<TemplateFilters
					value={filter}
					count={cards.length}
					onChange={(next, changed) => {
						setFilter(next);
						onFilterChange?.(changed, next[changed] ?? "none");
					}}
				/>
			}
			empty={cards.length === 0}
			onUpload={onUpload}
			onStartBlank={onStartBlank}
			gap="lg"
			testId="all-formats"
		>
			<SimpleGrid
				cols={{ base: 1, md: 3, sm: 2 }}
				spacing="sm"
				data-testid="all-formats-grid"
			>
				{cards.map((tpl) => (
					<TemplateCardButton
						key={tpl.key}
						template={tpl}
						onChoose={() =>
							onChoose(tpl.key, {
								featured: tpl.card.featured,
								filtersActive: activeFilters(filter),
								list: "all_formats",
								setup: tpl.card.setup,
								verbs: tpl.card.verbs,
							})
						}
					/>
				))}
			</SimpleGrid>
		</TemplateChooser>
	);
};
