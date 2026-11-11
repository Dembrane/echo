import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Group,
	SimpleGrid,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { UploadSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import {
	type CardKey,
	linkLabel,
	linkLine,
	NO_FILTER,
	type TemplateFilter,
	type TemplateSummary,
	visibleCards,
} from "../projectTemplates";
import { TemplateCardButton } from "../TemplateCard/TemplateCardButton";
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
		<Stack gap="lg" data-testid="all-formats">
			<Stack gap="xs">
				<Title order={3}>
					<Trans>What are you going to do?</Trans>
				</Title>
				<Text size="sm" className="app-muted">
					<Trans>
						Pick the closest fit and dembrane sets the project up for it, with a
						host script for the room. You can change every setting later.
					</Trans>
				</Text>
			</Stack>

			{!templates && !failed ? (
				<Stack gap="sm" aria-busy="true" aria-label={t`Loading templates`}>
					<Skeleton height={40} />
					<Skeleton height={240} />
				</Stack>
			) : failed ? (
				<Text size="sm" data-testid="template-picker-failed">
					<Trans>
						The templates did not load. You can still start blank and set it up
						yourself.
					</Trans>
				</Text>
			) : (
				<>
					<TemplateFilters
						value={filter}
						showAll
						withShowAll={false}
						count={cards.length}
						onChange={(next, changed) => {
							setFilter(next);
							onFilterChange?.(changed, next[changed] ?? "none");
						}}
						onShowAll={() => {}}
					/>
					{cards.length === 0 ? (
						<Text size="sm" data-testid="template-picker-none">
							<Trans>
								No template fits both. Clear a filter, or start blank.
							</Trans>
						</Text>
					) : (
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
					)}
				</>
			)}

			<Stack gap="xs" data-testid="template-picker-links">
				{!failed && (
					<Group gap="xs" align="baseline" wrap="wrap">
						<Anchor
							component="button"
							type="button"
							size="sm"
							onClick={onUpload}
							data-testid="template-picker-upload"
						>
							<Group gap="xs" component="span" wrap="nowrap">
								<UploadSimpleIcon size={16} aria-hidden />
								{linkLabel("upload")}
							</Group>
						</Anchor>
						<Text size="xs" className="app-muted">
							{linkLine("upload")}
						</Text>
					</Group>
				)}
				<Group gap="xs" align="baseline" wrap="wrap">
					<Anchor
						component="button"
						type="button"
						size="sm"
						onClick={onStartBlank}
						data-testid="template-picker-start-blank"
					>
						{linkLabel("blank")}
					</Anchor>
					<Text size="xs" className="app-muted">
						{linkLine("blank")}
					</Text>
				</Group>
			</Stack>
		</Stack>
	);
};
