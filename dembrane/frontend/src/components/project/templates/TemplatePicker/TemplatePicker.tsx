import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Anchor, Group, Skeleton, Stack, Text, Title } from "@mantine/core";
import { UploadSimpleIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { SelectableCardGrid } from "@/components/common/SelectableCardGrid/SelectableCardGrid";
import {
	type CardKey,
	isCardKey,
	linkLabel,
	linkLine,
	NO_FILTER,
	setupLabel,
	TEMPLATE_ICONS,
	type TemplateFilter,
	type TemplateKey,
	type TemplateSummary,
	templateFacts,
	templateGreatFor,
	templateName,
	verbLabel,
	visibleCards,
} from "../projectTemplates";
import { TemplateCard } from "../TemplateCard/TemplateCard";
import { TemplateFilters } from "../TemplateFilters/TemplateFilters";

/** What the picker knew when a card was chosen, for analytics: never free text. */
export interface TemplateChoiceContext {
	featured: boolean;
	verbs: string[];
	setup: string;
	/** "verb:<verb>", "setup:<setup>" or "show_all"; empty in the first view. */
	filtersActive: string[];
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
		<Stack gap="md" data-testid="template-picker" data-tour="template-picker">
			<Stack gap="xs">
				<Title order={order} id={headingId}>
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
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} height={132} />
					))}
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
						showAll={showAll}
						count={cards.length}
						onChange={(next, changed) => {
							setFilter(next);
							onFilterChange?.(changed, next[changed] ?? "none");
						}}
						onShowAll={(next) => {
							setFilter(NO_FILTER);
							setShowAll(next);
							onFilterChange?.("show_all", next ? "on" : "off");
						}}
					/>
					{cards.length === 0 ? (
						<Text size="sm" data-testid="template-picker-none">
							<Trans>
								No template fits both. Clear a filter, or start blank.
							</Trans>
						</Text>
					) : (
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
											icon={TEMPLATE_ICONS[key]}
											name={templateName(key)}
											greatFor={templateGreatFor(key)}
											facts={templateFacts(tpl)}
											method={tpl.card.method}
											labels={[
												...tpl.card.verbs.map(verbLabel),
												setupLabel(tpl.card.setup),
											]}
										/>
									),
									testId: `template-card-${key}`,
									value: key,
								};
							})}
						/>
					)}
				</>
			)}

			{(onUpload || onStartBlank) && (
				<Stack gap={6} data-testid="template-picker-links">
					{onUpload && !failed && (
						<Group gap="xs" align="baseline" wrap="wrap">
							<Anchor
								component="button"
								type="button"
								size="sm"
								onClick={onUpload}
								data-testid="template-picker-upload"
							>
								<Group gap={6} component="span" wrap="nowrap">
									<UploadSimpleIcon size={16} aria-hidden />
									{linkLabel("upload")}
								</Group>
							</Anchor>
							<Text size="xs" className="app-muted">
								{linkLine("upload")}
							</Text>
						</Group>
					)}
					{onStartBlank && (
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
					)}
				</Stack>
			)}
		</Stack>
	);
};
