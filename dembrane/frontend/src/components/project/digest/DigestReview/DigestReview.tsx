import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Checkbox,
	Group,
	List,
	Select,
	Stack,
	TagsInput,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";
import { FlowProgress } from "@/components/common/FlowProgress/FlowProgress";
import { SuggestedTerms } from "@/components/project/setup-suggestions/SuggestedTerms/SuggestedTerms";
import {
	CARD_KEYS,
	cardTags,
	isCardKey,
	type TemplateSummary,
	templateGreatFor,
	templateName,
	topicLabel,
} from "@/components/project/templates/projectTemplates";
import { TemplateCard } from "@/components/project/templates/TemplateCard/TemplateCard";
import { BUILT_IN_TOPIC_KEYS } from "@/components/verify/topics";
import type { DigestReviewStep } from "@/lib/analytics/events";
import { testId } from "@/lib/testUtils";
import type { DigestResult } from "../digest";
import {
	chooseTemplate,
	edit,
	type ReviewState,
	type ReviewStep,
	reviewSteps,
	type SectionKey,
	stepName,
	toggle,
} from "../review";
import { ReviewSection } from "./ReviewSection";
import { ReviewSummary, type SummaryLine } from "./ReviewSummary";

const RULE = "var(--app-stroke) solid var(--app-rule-color)";

/** What the review tells analytics: step names and counts, never what a part says. */
export type ReviewStepEvent =
	| { type: "viewed"; step: DigestReviewStep; index: number; total: number }
	| {
			type: "answered";
			step: DigestReviewStep;
			action: "accepted" | "edited" | "skipped";
	  }
	| { type: "rest"; step: DigestReviewStep; remaining: number };

interface DigestReviewProps {
	result: DigestResult;
	value: ReviewState;
	onChange: (next: ReviewState) => void;
	templates: readonly TemplateSummary[];
	creating?: boolean;
	onCreate: () => void;
	onStartOver: () => void;
	onStep?: (event: ReviewStepEvent) => void;
}

const isSection = (step: ReviewStep): step is SectionKey =>
	step !== "name" && step !== "template" && step !== "summary";

/** The step's id in test ids and walkthrough anchors, as the one-screen review had them. */
const stepId = (step: ReviewStep) =>
	step === "keyTerms"
		? "key-terms"
		: step === "nameLabel"
			? "name-label"
			: step === "hostSteps"
				? "host-steps"
				: step;

/**
 * "Here is what dembrane understood", one part per screen (ECHO-1058): the name, goal,
 * context, key terms, template, rounds as tags, Verify, name box, Explore question and host
 * script additions, each with where it came from, to accept, edit in place or skip; parts
 * the digest proposed nothing for are left out. Back keeps every edit; "Accept the rest"
 * goes to the summary, which lists each part in a line with a way back to change it, then
 * Create. Nothing is saved before Create. Props in, callbacks out.
 */
export const DigestReview = ({
	result,
	value,
	onChange,
	templates,
	creating = false,
	onCreate,
	onStartOver,
	onStep,
}: DigestReviewProps) => {
	const steps = reviewSteps(result);
	const [index, setIndex] = useState(0);
	const [editing, setEditing] = useState(!value.name.trim());
	// Opened from the summary's "Change": accepting goes back there.
	const [fromSummary, setFromSummary] = useState(false);
	const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
	const step = steps[index] ?? "summary";
	const p = result.provenance;
	const set = (next: ReviewState) => onChange(next);
	const chosen =
		value.template && isCardKey(value.template) ? value.template : null;
	const summary = templates.find((tpl) => tpl.key === chosen);
	const proposed = result.template?.key ?? null;
	const canCreate = Boolean(value.name.trim() && chosen);
	const summaryIndex = steps.length - 1;

	// biome-ignore lint/correctness/useExhaustiveDependencies: counted once per screen shown
	useEffect(() => {
		onStep?.({
			index: index + 1,
			step: stepName(step) as DigestReviewStep,
			total: steps.length,
			type: "viewed",
		});
	}, [index]);

	const go = (to: number) => {
		const next = Math.max(0, Math.min(summaryIndex, to));
		const nextStep = steps[next];
		setEditing(nextStep === "name" && !value.name.trim());
		setIndex(next);
		window.scrollTo?.({ top: 0 });
	};
	const forward = () => {
		if (fromSummary) {
			setFromSummary(false);
			go(summaryIndex);
		} else go(index + 1);
	};
	const answer = (action: "accepted" | "edited" | "skipped") =>
		onStep?.({
			action,
			step: stepName(step) as DigestReviewStep,
			type: "answered",
		});

	const accept = () => {
		if (step === "name" && !value.name.trim()) return;
		if (isSection(step) && !value[step].on) set(toggle(value, step, true));
		answer(editing ? "edited" : "accepted");
		forward();
	};
	const skip = () => {
		if (!isSection(step)) return;
		set(toggle(value, step, false));
		answer("skipped");
		forward();
	};
	const acceptRest = () => {
		onStep?.({
			remaining: summaryIndex - index - 1,
			step: stepName(step) as DigestReviewStep,
			type: "rest",
		});
		setFromSummary(false);
		go(summaryIndex);
	};

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

	const titles: Record<Exclude<ReviewStep, "summary">, string> = {
		context: t`Project context`,
		explore: t`Explore question`,
		goal: t`Goal`,
		hostSteps: t`Host script additions`,
		keyTerms: t`Key terms`,
		name: t`Name`,
		nameLabel: t`Name box`,
		tags: t`Rounds as tags`,
		template: t`Template`,
		verify: t`Verify`,
	};

	const progress = (
		<FlowProgress
			step={index + 1}
			total={steps.length}
			testId="project-digest-progress-bar"
		/>
	);

	// A row of steps: Back (or Start over) on the left (rules.css).
	const footer = (
		<Group
			data-steps
			gap="sm"
			justify="space-between"
			pt="md"
			style={{ borderTop: RULE }}
			wrap="wrap"
		>
			{index === 0 ? (
				<Button
					variant="subtle"
					color="gray"
					size="sm"
					onClick={onStartOver}
					{...testId("project-digest-start-over")}
				>
					<Trans>Start over</Trans>
				</Button>
			) : (
				<Button
					variant="subtle"
					color="gray"
					size="sm"
					onClick={() => {
						setFromSummary(false);
						go(index - 1);
					}}
					{...testId("project-digest-back")}
				>
					<Trans>Back</Trans>
				</Button>
			)}
			{step !== "summary" && index < summaryIndex - 1 ? (
				<Button
					variant="subtle"
					size="sm"
					onClick={acceptRest}
					{...testId("project-digest-accept-rest")}
				>
					<Trans>Accept the rest</Trans>
				</Button>
			) : step === "summary" ? (
				<Button
					variant="subtle"
					color="gray"
					size="sm"
					onClick={onStartOver}
					{...testId("project-digest-start-over")}
				>
					<Trans>Start over</Trans>
				</Button>
			) : null}
		</Group>
	);

	if (step === "summary") {
		const line = (s: Exclude<ReviewStep, "summary">): SummaryLine => ({
			skipped: isSection(s) && !value[s].on,
			step: s,
			title: titles[s],
			value: lineValue(s),
		});
		const lineValue = (s: Exclude<ReviewStep, "summary">): string => {
			switch (s) {
				case "name":
					return value.name.trim();
				case "template":
					return chosen ? templateName(chosen) : "";
				case "verify":
					return value.verify.value.map(topicLabel).join(", ");
				case "keyTerms":
				case "tags":
				case "hostSteps":
					return value[s].value.filter(Boolean).join(" · ");
				default:
					return value[s].value.trim();
			}
		};
		return (
			<Stack gap="lg" {...testId("project-digest-review")} data-step="summary">
				{progress}
				<ReviewSummary
					lines={steps
						.filter((s): s is Exclude<ReviewStep, "summary"> => s !== "summary")
						.map(line)}
					onChange={(s) => {
						setFromSummary(true);
						go(steps.indexOf(s));
					}}
					canCreate={canCreate}
					creating={creating}
					onCreate={onCreate}
					footer={footer}
				/>
			</Stack>
		);
	}

	const intro =
		index === 0 ? (
			<Stack gap={4}>
				<Text size="sm">
					<Trans>
						One part at a time: accept it, edit it or skip it. Nothing is saved
						until you create the project.
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
		) : null;

	const id = stepId(step);
	const readText = (text: string) =>
		text.trim() ? (
			<Text size="md" style={{ whiteSpace: "pre-wrap" }}>
				{text}
			</Text>
		) : (
			<Text size="sm" className="app-muted">
				<Trans>Nothing yet</Trans>
			</Text>
		);
	const readTags = (items: readonly string[]) =>
		items.filter(Boolean).length ? (
			<Group gap="xs" wrap="wrap">
				{items.filter(Boolean).map((x) => (
					<Badge key={x} size="md">
						{x}
					</Badge>
				))}
			</Group>
		) : (
			readText("")
		);

	let body: ReactNode = null;
	let hint: ReactNode = null;
	let provenance = null as (typeof p)[keyof typeof p] | null;
	let editable = true;
	switch (step) {
		case "name":
			provenance = p.name ?? null;
			body = editing ? (
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
			) : (
				readText(value.name)
			);
			break;
		case "goal":
			hint = t`What you want to learn or decide. Saved as the project's first goal.`;
			provenance = p.goal ?? null;
			body = editing ? (
				<Textarea
					aria-label={t`Goal`}
					autosize
					minRows={2}
					maxLength={1000}
					value={value.goal.value}
					onChange={(e) => set(edit(value, "goal", e.currentTarget.value))}
					{...testId("project-digest-goal")}
				/>
			) : (
				readText(value.goal.value)
			);
			break;
		case "context":
			hint = t`What, who, where and the questions. dembrane reads it to keep answers and summaries on your question.`;
			provenance = p.context ?? null;
			body = editing ? (
				<Textarea
					aria-label={t`Project context`}
					autosize
					minRows={3}
					maxRows={12}
					value={value.context.value}
					onChange={(e) => set(edit(value, "context", e.currentTarget.value))}
					{...testId("project-digest-context")}
				/>
			) : (
				readText(value.context.value)
			);
			break;
		case "keyTerms":
			hint = t`Names and words transcription should spell right. Each one is in your material.`;
			body = editing ? (
				<div data-own-enter>
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
				</div>
			) : (
				readTags(value.keyTerms.value)
			);
			break;
		case "template":
			editable = false;
			provenance = p.template_key ?? null;
			body = (
				<Stack gap="md">
					{chosen ? (
						<Stack
							gap="xs"
							py="md"
							maw={360}
							style={{ borderBottom: RULE, borderTop: RULE }}
							{...testId("project-digest-template-card")}
						>
							<TemplateCard
								template={chosen}
								name={templateName(chosen)}
								greatFor={templateGreatFor(chosen)}
								tags={summary ? cardTags(summary) : []}
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
					<div data-own-enter>
						<Select
							label={t`Or choose another`}
							placeholder={t`All templates`}
							data={CARD_KEYS.map((k) => ({
								label: templateName(k),
								value: k,
							}))}
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
					</div>
				</Stack>
			);
			break;
		case "tags":
			hint = t`Participants tap the round they are in before they record.`;
			provenance = p.tags ?? null;
			body = editing ? (
				<div data-own-enter>
					<TagsInput
						aria-label={t`Rounds as tags`}
						value={value.tags.value}
						onChange={(tags) => set(edit(value, "tags", tags))}
						maxTags={8}
						splitChars={[","]}
						{...testId("project-digest-tags")}
					/>
				</div>
			) : (
				readTags(value.tags.value)
			);
			break;
		case "verify":
			hint = t`What participants check together at the end of their conversation.`;
			provenance = p.verify_topics ?? null;
			body = editing ? (
				<Checkbox.Group
					aria-label={t`Verify options`}
					value={value.verify.value}
					onChange={(topics) => set(edit(value, "verify", topics.slice(0, 3)))}
					{...testId("project-digest-verify")}
				>
					<Group gap="md" wrap="wrap" mt={4}>
						{BUILT_IN_TOPIC_KEYS.map((k) => (
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
			) : (
				readTags(value.verify.value.map(topicLabel))
			);
			break;
		case "nameLabel":
			hint = t`What the portal asks each group to type before recording.`;
			provenance = p.name_label ?? null;
			body = editing ? (
				<TextInput
					aria-label={t`Name box`}
					maxLength={80}
					value={value.nameLabel.value}
					onChange={(e) => set(edit(value, "nameLabel", e.currentTarget.value))}
					{...testId("project-digest-name-label")}
				/>
			) : (
				readText(value.nameLabel.value)
			);
			break;
		case "explore":
			hint = t`When a group presses Explore, dembrane asks one open question built from your questions. It never gives its own opinion.`;
			provenance = p.explore_prompt ?? null;
			body = editing ? (
				<Textarea
					aria-label={t`Explore question`}
					autosize
					minRows={2}
					maxLength={600}
					value={value.explore.value}
					onChange={(e) => set(edit(value, "explore", e.currentTarget.value))}
					{...testId("project-digest-explore")}
				/>
			) : (
				readText(value.explore.value)
			);
			break;
		case "hostSteps":
			hint = t`Steps for this session, added after the template's host script.`;
			provenance = p.host_script_additions ?? null;
			body = editing ? (
				<Stack gap="xs">
					{value.hostSteps.value.map((s, i) => (
						<Textarea
							// biome-ignore lint/suspicious/noArrayIndexKey: steps are edited in place
							key={i}
							aria-label={t`Step ${i + 1}`}
							autosize
							minRows={1}
							maxLength={200}
							value={s}
							onChange={(e) =>
								set(
									edit(
										value,
										"hostSteps",
										value.hostSteps.value.map((x, j) =>
											j === i ? e.currentTarget.value : x,
										),
									),
								)
							}
							{...testId(`project-digest-host-step-${i}`)}
						/>
					))}
				</Stack>
			) : (
				<List type="ordered" spacing="xs" size="md">
					{value.hostSteps.value.map((s, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list read in order
						<List.Item key={i}>{s}</List.Item>
					))}
				</List>
			);
			break;
	}

	return (
		<Stack gap="lg" {...testId("project-digest-review")} data-step={id}>
			{progress}
			<ReviewSection
				id={id}
				stepKey={step}
				title={titles[step]}
				hint={hint}
				provenance={provenance}
				intro={intro}
				skipped={isSection(step) && !value[step].on}
				editing={editable ? editing : undefined}
				onEdit={editable ? () => setEditing(true) : undefined}
				onSkip={isSection(step) ? skip : undefined}
				onAccept={accept}
				canAccept={step !== "name" || Boolean(value.name.trim())}
				footer={footer}
			>
				{body}
			</ReviewSection>
		</Stack>
	);
};
