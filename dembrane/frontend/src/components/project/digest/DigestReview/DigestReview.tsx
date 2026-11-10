import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Checkbox,
	Group,
	Select,
	Stack,
	TagsInput,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useState } from "react";
import { SuggestedTerms } from "@/components/project/setup-suggestions/SuggestedTerms/SuggestedTerms";
import {
	CARD_KEYS,
	isCardKey,
	TEMPLATE_ICONS,
	type TemplateSummary,
	templateFacts,
	templateGreatFor,
	templateName,
	topicLabel,
} from "@/components/project/templates/projectTemplates";
import { TemplateCard } from "@/components/project/templates/TemplateCard/TemplateCard";
import { testId } from "@/lib/testUtils";
import type { DigestResult } from "../digest";
import {
	chooseTemplate,
	edit,
	type ReviewState,
	type SectionKey,
	sectionsShown,
	toggle,
} from "../review";
import { ReviewSection } from "./ReviewSection";

const TOPICS = [
	"agreements",
	"disagreements",
	"actions",
	"gems",
	"truths",
	"heard",
	"moments",
] as const;

const RULE = "var(--app-stroke) solid var(--app-rule-color)";

interface DigestReviewProps {
	result: DigestResult;
	value: ReviewState;
	onChange: (next: ReviewState) => void;
	templates: readonly TemplateSummary[];
	creating?: boolean;
	onCreate: () => void;
	onStartOver: () => void;
}

/**
 * "Here is what dembrane understood": each part of the digest in its own section, edited
 * in place or switched off, with where it came from. One primary action creates the
 * project with what is on; nothing is saved before. Props in, callbacks out.
 */
export const DigestReview = ({
	result,
	value,
	onChange,
	templates,
	creating = false,
	onCreate,
	onStartOver,
}: DigestReviewProps) => {
	const shown = new Set(sectionsShown(result));
	const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
	const p = result.provenance;
	const chosen =
		value.template && isCardKey(value.template) ? value.template : null;
	const summary = templates.find((tpl) => tpl.key === chosen);
	const proposed = result.template?.key ?? null;
	const set = (next: ReviewState) => onChange(next);
	const onOff = (key: SectionKey) => ({
		on: value[key].on,
		onToggle: (on: boolean) => set(toggle(value, key, on)),
	});
	const terms = result.key_terms
		.filter((term) => !hidden.has(term.term))
		.map((term) => ({
			reason: [term.reason, t`From ${term.source}: “${term.snippet}”`]
				.filter(Boolean)
				.join(" "),
			source: "text" as const,
			term: term.term,
		}));
	const accepted = (term: string) => value.keyTerms.value.includes(term);
	const setTerms = (list: string[]) => set(edit(value, "keyTerms", list));
	const canCreate = Boolean(value.name.trim() && chosen);

	return (
		<Stack gap="lg" {...testId("project-digest-review")}>
			<Stack gap="xs">
				<Title order={4}>
					<Trans>Here is what dembrane understood</Trans>
				</Title>
				<Text size="sm">
					<Trans>
						Check each part, change what's off and switch off what you don't
						want. Nothing is saved until you create the project.
					</Trans>
				</Text>
				<Text
					size="xs"
					className="app-muted"
					{...testId("project-digest-read-from")}
				>
					{t`Read from: ${result.sources.map((s) => s.name).join(", ")}`}
				</Text>
				{result.notes.includes("material_cut") && (
					<Text
						size="xs"
						className="app-muted"
						{...testId("project-digest-note-cut")}
					>
						<Trans>
							Your material was long, so dembrane read its start and a condensed
							version. Check that nothing important is missing.
						</Trans>
					</Text>
				)}
				{result.notes.includes("personal_data_removed") && (
					<Text
						size="xs"
						className="app-muted"
						{...testId("project-digest-note-personal")}
					>
						<Trans>
							Contact details and lists of names were left out of the context.
						</Trans>
					</Text>
				)}
				{result.notes.includes("url_not_read") && (
					<Text
						size="xs"
						className="app-muted"
						{...testId("project-digest-note-url")}
					>
						<Trans>
							The link could not be read, so this comes from your files and
							text.
						</Trans>
					</Text>
				)}
			</Stack>

			<ReviewSection id="name" title={t`Name`} provenance={p.name}>
				<TextInput
					aria-label={t`Project name`}
					value={value.name}
					onChange={(e) =>
						set({ ...value, name: e.currentTarget.value, nameEdited: true })
					}
					error={
						value.name.trim()
							? undefined
							: t`Give the project a name to create it.`
					}
					{...testId("project-digest-name")}
				/>
			</ReviewSection>

			{shown.has("goal") && (
				<ReviewSection
					id="goal"
					title={t`Goal`}
					hint={t`What you want to learn or decide. Saved as the project's first goal.`}
					provenance={p.goal}
					switchLabel={t`Use this goal`}
					{...onOff("goal")}
				>
					<Textarea
						aria-label={t`Goal`}
						autosize
						minRows={2}
						maxLength={1000}
						value={value.goal.value}
						onChange={(e) => set(edit(value, "goal", e.currentTarget.value))}
						{...testId("project-digest-goal")}
					/>
				</ReviewSection>
			)}

			{shown.has("context") && (
				<ReviewSection
					id="context"
					title={t`Project context`}
					hint={t`What, who, where and the questions. dembrane reads it to keep answers and summaries on your question.`}
					provenance={p.context}
					switchLabel={t`Use this context`}
					{...onOff("context")}
				>
					<Textarea
						aria-label={t`Project context`}
						autosize
						minRows={3}
						maxRows={12}
						value={value.context.value}
						onChange={(e) => set(edit(value, "context", e.currentTarget.value))}
						{...testId("project-digest-context")}
					/>
				</ReviewSection>
			)}

			{shown.has("keyTerms") && (
				<ReviewSection
					id="key-terms"
					title={t`Key terms`}
					hint={t`Names and words transcription should spell right. Each one is in your material.`}
					switchLabel={t`Use these key terms`}
					{...onOff("keyTerms")}
				>
					<SuggestedTerms
						terms={terms}
						isAccepted={accepted}
						total={value.keyTerms.value.length}
						onToggle={(term) =>
							setTerms(
								accepted(term)
									? value.keyTerms.value.filter((x) => x !== term)
									: [...value.keyTerms.value, term],
							)
						}
						onRemove={(term) => {
							setHidden((prev) => new Set([...prev, term]));
							setTerms(value.keyTerms.value.filter((x) => x !== term));
						}}
						onAcceptAll={() => setTerms(terms.map((x) => x.term))}
					/>
				</ReviewSection>
			)}

			<ReviewSection
				id="template"
				title={t`Template`}
				provenance={p.template_key}
			>
				<Stack gap="sm">
					{chosen ? (
						<Stack
							gap="xs"
							p="md"
							style={{ borderBottom: RULE, borderTop: RULE }}
							{...testId("project-digest-template-card")}
						>
							<TemplateCard
								icon={TEMPLATE_ICONS[chosen]}
								name={templateName(chosen)}
								greatFor={templateGreatFor(chosen)}
								facts={summary ? templateFacts(summary) : []}
							/>
							{chosen === proposed && result.template?.reason ? (
								<Text size="sm" {...testId("project-digest-template-reason")}>
									{t`Why this one: ${result.template.reason}`}
								</Text>
							) : null}
						</Stack>
					) : (
						<Text size="sm" className="app-muted">
							<Trans>Choose the template that fits the session.</Trans>
						</Text>
					)}
					{(result.template?.runner_ups ?? []).some((k) => k !== chosen) ||
					(proposed && proposed !== chosen) ? (
						<Group
							gap="xs"
							wrap="wrap"
							{...testId("project-digest-runner-ups")}
						>
							<Text size="sm" span>
								<Trans>Also fits:</Trans>
							</Text>
							{[proposed, ...(result.template?.runner_ups ?? [])]
								.filter(
									(k): k is string =>
										Boolean(k) && k !== chosen && isCardKey(k),
								)
								.filter((k, i, all) => all.indexOf(k) === i)
								.map((k) => (
									<Button
										key={k}
										variant="outline"
										size="xs"
										onClick={() =>
											set(
												chooseTemplate(
													value,
													k,
													templates,
													result.verify_topics,
												),
											)
										}
										styles={{ label: { textTransform: "none" } }}
										{...testId(`project-digest-runner-up-${k}`)}
									>
										{isCardKey(k) ? templateName(k) : k}
									</Button>
								))}
						</Group>
					) : null}
					<Select
						label={t`Or choose another`}
						placeholder={t`All templates`}
						data={CARD_KEYS.map((k) => ({ label: templateName(k), value: k }))}
						value={null}
						onChange={(k) =>
							k &&
							set(chooseTemplate(value, k, templates, result.verify_topics))
						}
						searchable
						comboboxProps={{ withinPortal: true }}
						maw={360}
						{...testId("project-digest-template-select")}
					/>
				</Stack>
			</ReviewSection>

			{shown.has("tags") && (
				<ReviewSection
					id="tags"
					title={t`Rounds as tags`}
					hint={t`Participants tap the round they are in before they record.`}
					provenance={p.tags}
					switchLabel={t`Use these tags`}
					{...onOff("tags")}
				>
					<TagsInput
						aria-label={t`Rounds as tags`}
						value={value.tags.value}
						onChange={(tags) => set(edit(value, "tags", tags))}
						maxTags={8}
						splitChars={[","]}
						{...testId("project-digest-tags")}
					/>
				</ReviewSection>
			)}

			{shown.has("verify") && (
				<ReviewSection
					id="verify"
					title={t`Verify`}
					hint={t`What participants check together at the end of their conversation.`}
					provenance={p.verify_topics}
					switchLabel={t`Use these Verify options`}
					{...onOff("verify")}
				>
					<Checkbox.Group
						aria-label={t`Verify options`}
						value={value.verify.value}
						onChange={(topics) =>
							set(edit(value, "verify", topics.slice(0, 3)))
						}
						{...testId("project-digest-verify")}
					>
						<Group gap="md" wrap="wrap" mt={4}>
							{TOPICS.map((k) => (
								<Checkbox
									key={k}
									value={k}
									label={topicLabel(k)}
									disabled={
										!value.verify.value.includes(k) &&
										value.verify.value.length >= 3
									}
								/>
							))}
						</Group>
					</Checkbox.Group>
				</ReviewSection>
			)}

			{shown.has("nameLabel") && (
				<ReviewSection
					id="name-label"
					title={t`Name box`}
					hint={t`What the portal asks each group to type before recording.`}
					provenance={p.name_label}
					switchLabel={t`Use this name box label`}
					{...onOff("nameLabel")}
				>
					<TextInput
						aria-label={t`Name box`}
						maxLength={80}
						value={value.nameLabel.value}
						onChange={(e) =>
							set(edit(value, "nameLabel", e.currentTarget.value))
						}
						{...testId("project-digest-name-label")}
					/>
				</ReviewSection>
			)}

			{shown.has("explore") && (
				<ReviewSection
					id="explore"
					title={t`Explore question`}
					hint={t`When a group presses Explore, dembrane asks one open question built from your questions. It never gives its own opinion.`}
					provenance={p.explore_prompt}
					switchLabel={t`Use this Explore question`}
					{...onOff("explore")}
				>
					<Textarea
						aria-label={t`Explore question`}
						autosize
						minRows={2}
						maxLength={600}
						value={value.explore.value}
						onChange={(e) => set(edit(value, "explore", e.currentTarget.value))}
						{...testId("project-digest-explore")}
					/>
				</ReviewSection>
			)}

			{shown.has("hostSteps") && (
				<ReviewSection
					id="host-steps"
					title={t`Host script additions`}
					hint={t`Steps for this session, added after the template's host script.`}
					provenance={p.host_script_additions}
					switchLabel={t`Use these host script steps`}
					{...onOff("hostSteps")}
				>
					<Stack gap="xs">
						{value.hostSteps.value.map((step, i) => (
							<Textarea
								// biome-ignore lint/suspicious/noArrayIndexKey: steps are edited in place
								key={i}
								aria-label={t`Step ${i + 1}`}
								autosize
								minRows={1}
								maxLength={200}
								value={step}
								onChange={(e) =>
									set(
										edit(
											value,
											"hostSteps",
											value.hostSteps.value.map((s, j) =>
												j === i ? e.currentTarget.value : s,
											),
										),
									)
								}
								{...testId(`project-digest-host-step-${i}`)}
							/>
						))}
					</Stack>
				</ReviewSection>
			)}

			<Group gap="sm" pt="md" style={{ borderTop: RULE }}>
				<Button
					variant="filled"
					size="sm"
					loading={creating}
					disabled={!canCreate}
					onClick={onCreate}
					{...testId("project-digest-create")}
				>
					<Trans>Create project</Trans>
				</Button>
				<Button
					variant="subtle"
					color="gray"
					size="sm"
					onClick={onStartOver}
					{...testId("project-digest-start-over")}
				>
					<Trans>Start over</Trans>
				</Button>
			</Group>
		</Stack>
	);
};
