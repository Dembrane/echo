import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Group,
	NumberInput,
	Paper,
	Select,
	Skeleton,
	Stack,
	Switch,
	Tabs,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import {
	type AnalysisObject,
	type AnalysisRecipe,
	type AnalysisRun,
	type AnalysisSource,
	useAnalysisEvents,
	useAnalysisRecipes,
	useAnalysisRun,
	useAnalysisRuns,
	useAnalysisSources,
	useCancelAnalysisRun,
	useRequestAnalysisRun,
	useResultsList,
	useResultsVisit,
} from "@/components/analysis/hooks";
import { EntityListRow } from "@/components/common/EntityListRow";
import { I18nLink } from "@/components/common/i18nLink";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { PageContainer } from "@/components/layout/PageContainer";
import {
	type PopcornDetail,
	useCreatePopcornMutation,
	useProjectPopcorn,
} from "@/components/popcorn/hooks";
import { PopcornVoiceSection } from "@/components/popcorn/PopcornVoiceSection";
import {
	ResultItem,
	ResultsList,
	useResultActions,
} from "@/components/results";
import { openConfirm } from "@/lib/openConfirm";
import { testId } from "@/lib/testUtils";
import { useRecipeParameters } from "./useRecipeParameters";

type AnalysisTab = "results" | "recipes" | "runs";
const activeStatuses = new Set(["queued", "running", "waiting_for_inputs"]);
// A function, not a constant: `t` has to run with a locale active, which is
// only true once something renders.
const resultTypeLabels = (): Record<string, string> => ({
	argument: t`Arguments`,
	deduplicated_argument: t`Consolidated arguments`,
	popcorn: t`Popcorn phrases`,
	stakeholder: t`Stakeholders`,
	tension: t`Tensions`,
});

function dateLabel(value?: string | null) {
	return value
		? new Intl.DateTimeFormat(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(new Date(value))
		: t`Unknown time`;
}

function statusColor(status: string) {
	if (status === "ready") return "green";
	if (status === "failed") return "red";
	if (activeStatuses.has(status) || status === "needs_review") return "yellow";
	return "gray";
}

// A function for the same reason as resultTypeLabels. Unknown statuses show
// as they come.
function statusLabel(status: string) {
	const labels: Record<string, string> = {
		cancelled: t`Stopped`,
		failed: t`Failed`,
		needs_review: t`Needs review`,
		queued: t`Queued`,
		ready: t`Ready`,
		running: t`Running`,
		superseded: t`Superseded`,
		waiting_for_inputs: t`Waiting for inputs`,
	};
	return labels[status] ?? status;
}

function RunStatusBadge({ status }: { status: string }) {
	return <Badge color={statusColor(status)}>{statusLabel(status)}</Badge>;
}

// Rows inside one read block: a single rule between them, none doubled.
const ruledRow = {
	borderBottom: "var(--app-stroke) solid var(--app-rule-color)",
};
const ruledList = {
	borderTop: "var(--app-stroke) solid var(--app-rule-color)",
};

function LoadingBlocks() {
	return (
		<Stack gap="md">
			<Skeleton height={24} width="40%" />
			<Skeleton height={120} />
			<Skeleton height={120} />
		</Stack>
	);
}

function ResultsView({
	projectId,
	workspaceId,
}: {
	projectId: string;
	workspaceId?: string;
}) {
	const [params, setParams] = useSearchParams();
	const type = params.get("type") || undefined;
	const membership = params.get("membership") || "active";
	const query = params.get("q") ?? "";
	const objects = useResultsList(projectId, { membership, type });
	// What is new is new since the host last opened this list; leaving it marks
	// it seen.
	useResultsVisit(projectId);
	const [selected, setSelected] = useState<AnalysisObject | null>(null);
	const actions = useResultActions({ projectId });
	const mapPath = workspaceId
		? `/w/${workspaceId}/projects/${projectId}/map`
		: `/projects/${projectId}/map`;
	// The filter row writes to the address, like every other filter here.
	const write = (next: URLSearchParams) => setParams(next, { replace: true });
	return (
		<Stack gap="lg">
			<Group justify="flex-start">
				<Button component={I18nLink} to={mapPath}>
					<Trans>Open map</Trans>
				</Button>
			</Group>
			{objects.isError && (
				// useResultsList folds several queries and exposes no error object
				// for ErrorNotice, so this is the plain inline alert.
				<Alert
					color="red"
					icon={<WarningCircleIcon size={20} />}
					title={t`Results could not be loaded.`}
					{...testId("analysis-results-error")}
				>
					<Button size="xs" onClick={() => objects.refetch()}>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			)}
			{!objects.isLoading && !objects.isError && objects.total === 0 && (
				<Stack gap="sm" align="flex-start">
					<Text size="sm" c="dimmed">
						<Trans>
							No prepared results yet. Open Recipes to prepare results from this
							project's eligible conversations.
						</Trans>
					</Text>
					<Button
						onClick={() => {
							const next = new URLSearchParams(params);
							next.set("tab", "recipes");
							setParams(next);
						}}
					>
						<Trans>View recipes</Trans>
					</Button>
				</Stack>
			)}
			{!objects.isError && (objects.isLoading || objects.total > 0) && (
				<ResultsList
					actions={actions}
					canEdit={objects.canEdit}
					counts={objects.counts}
					density="check"
					filter={{
						kind: type ?? null,
						onChange: (next) => {
							const search = new URLSearchParams(params);
							if (next.kind !== undefined)
								next.kind
									? search.set("type", next.kind)
									: search.delete("type");
							if (next.status !== undefined)
								next.status && next.status !== "active"
									? search.set("membership", next.status)
									: search.delete("membership");
							if (next.query !== undefined)
								next.query ? search.set("q", next.query) : search.delete("q");
							write(search);
						},
						query,
						status: membership,
					}}
					items={objects.items}
					loading={objects.isLoading}
					loadingTypes={objects.loadingTypes}
					onLoadMore={objects.loadMore}
					onOpen={(item) =>
						setSelected((current) =>
							current?.objectId === item.objectId ? null : item,
						)
					}
					openObjectId={selected?.objectId ?? null}
					renderItem={(item) => (
						<ResultItem
							canEdit={objects.canEdit}
							item={item}
							mapHref={mapPath}
							onClose={() => setSelected(null)}
							onEditWords={actions}
							projectId={projectId}
						/>
					)}
				/>
			)}
		</Stack>
	);
}

function ParameterSummary({ recipe }: { recipe: AnalysisRecipe }) {
	const properties = Object.entries(recipe.parametersSchema?.properties ?? {});
	if (!properties.length)
		return (
			<Text size="sm">
				<Trans>No configurable parameters.</Trans>
			</Text>
		);
	return (
		<Stack gap={0} style={ruledList}>
			{properties.map(([name, schema]) => {
				const minimum =
					schema.minimum === undefined ? null : String(schema.minimum);
				const maximum =
					schema.maximum === undefined ? null : String(schema.maximum);
				const defaultValue =
					schema.default === undefined ? null : String(schema.default);
				return (
					<Box key={name} py="sm" style={ruledRow}>
						<Text>{name}</Text>
						<Text size="sm" c="dimmed">
							{String(schema.description ?? schema.title ?? schema.type ?? "")}
						</Text>
						<Group gap="xs">
							{defaultValue !== null && (
								<Badge>
									<Trans>Default: {defaultValue}</Trans>
								</Badge>
							)}
							{minimum !== null && (
								<Badge>
									<Trans>min {minimum}</Trans>
								</Badge>
							)}
							{maximum !== null && (
								<Badge>
									<Trans>max {maximum}</Trans>
								</Badge>
							)}
						</Group>
					</Box>
				);
			})}
		</Stack>
	);
}

function RecipeParameters({
	recipe,
	values,
	onChange,
}: {
	recipe: AnalysisRecipe;
	values: Record<string, unknown>;
	onChange: (name: string, value: unknown) => void;
}) {
	const properties = Object.entries(recipe.parametersSchema?.properties ?? {});
	const supported = properties.filter(
		([, schema]) =>
			schema.type === "boolean" ||
			schema.type === "number" ||
			schema.type === "integer" ||
			schema.type === "string",
	);
	if (!supported.length) return <ParameterSummary recipe={recipe} />;
	return (
		<Stack gap="sm">
			{supported.map(([name, schema]) => {
				const label = String(schema.title ?? name);
				const description =
					typeof schema.description === "string"
						? schema.description
						: undefined;
				if (Array.isArray(schema.enum))
					return (
						<Select
							key={name}
							label={label}
							description={description}
							value={
								typeof values[name] === "string" ? String(values[name]) : null
							}
							data={schema.enum.map((entry) => String(entry))}
							onChange={(value) => onChange(name, value)}
						/>
					);
				if (schema.type === "boolean")
					return (
						<Switch
							key={name}
							label={label}
							description={description}
							checked={Boolean(values[name])}
							onChange={(event) => onChange(name, event.currentTarget.checked)}
						/>
					);
				if (schema.type === "number" || schema.type === "integer")
					return (
						<NumberInput
							key={name}
							label={label}
							description={description}
							value={typeof values[name] === "number" ? values[name] : ""}
							min={
								typeof schema.minimum === "number" ? schema.minimum : undefined
							}
							max={
								typeof schema.maximum === "number" ? schema.maximum : undefined
							}
							allowDecimal={schema.type === "number"}
							onChange={(value) => onChange(name, value)}
						/>
					);
				return (
					<TextInput
						key={name}
						label={label}
						description={description}
						value={typeof values[name] === "string" ? values[name] : ""}
						onChange={(event) => onChange(name, event.currentTarget.value)}
					/>
				);
			})}
		</Stack>
	);
}

function PopcornVoiceRecipeSettings({
	projectId,
	popcorn,
	canEdit,
}: {
	projectId: string;
	popcorn?: PopcornDetail | null;
	canEdit: boolean;
}) {
	const create = useCreatePopcornMutation(projectId);
	if (!canEdit) return null;
	if (popcorn)
		return (
			<PopcornVoiceSection
				projectId={projectId}
				popcorn={popcorn}
				showTitle={false}
			/>
		);
	return (
		<Paper withBorder p="lg">
			<Stack gap="sm">
				<Title order={4}>
					<Trans>Voice</Trans>
				</Title>
				<Text size="sm" c="dimmed">
					<Trans>
						Create the presentation settings to choose how Popcorn phrases
						should sound. This does not prepare any results.
					</Trans>
				</Text>
				<Button
					w="fit-content"
					loading={create.isPending}
					onClick={() => create.mutate({ title: t`Popcorn` })}
				>
					<Trans>Create voice settings</Trans>
				</Button>
			</Stack>
		</Paper>
	);
}

function RecipeCard({
	recipe,
	runs,
	projectId,
	sources,
	popcorn,
	canRun,
	onShowResults,
}: {
	recipe: AnalysisRecipe;
	runs: AnalysisRun[];
	projectId: string;
	sources: AnalysisSource[];
	popcorn?: PopcornDetail | null;
	canRun: boolean;
	onShowResults: () => void;
}) {
	const request = useRequestAnalysisRun(projectId);
	const isConversationScoped = recipe.scopeKeyPattern.includes("conversation:");
	const [conversationId, setConversationId] = useState<string | null>(null);
	const defaults = useMemo(
		() =>
			Object.fromEntries(
				Object.entries(recipe.parametersSchema?.properties ?? {})
					.filter(([, schema]) => schema.default !== undefined)
					.map(([name, schema]) => [name, schema.default]),
			),
		[recipe.parametersSchema],
	);
	const scopeKey =
		isConversationScoped && conversationId
			? `conversation:${conversationId}`
			: "project";
	const latestRun = runs.find(
		(run) => run.recipeId === recipe.id && run.scopeKey === scopeKey,
	);
	const { markRequested, parameters, setParameter } = useRecipeParameters({
		defaults,
		latestRun,
		recipeId: recipe.id,
		scopeKey,
	});
	const labels = resultTypeLabels();
	const isFailed = latestRun?.status === "failed";
	const isActive = Boolean(latestRun && activeStatuses.has(latestRun.status));
	const actionLabel = !latestRun
		? t`Prepare`
		: isFailed
			? t`Try again`
			: t`Update results`;
	const run = () =>
		request.mutate(
			{
				mode: isFailed ? "retry" : "refresh",
				parameters,
				recipe_id: recipe.id,
				retry_run_id: isFailed ? latestRun?.id : undefined,
				scope_key: scopeKey,
			},
			{ onSuccess: markRequested },
		);
	const runFresh = () =>
		request.mutate(
			{
				mode: "regenerate",
				parameters,
				recipe_id: recipe.id,
				scope_key: scopeKey,
			},
			{ onSuccess: markRequested },
		);
	const selectedSource = sources.find((source) => source.id === conversationId);
	const scopeLabel = isConversationScoped
		? selectedSource?.participant_name?.trim() ||
			(selectedSource
				? dateLabel(selectedSource.created_at)
				: t`the selected conversation`)
		: t`all eligible project conversations`;
	return (
		<Card withBorder padding="lg">
			<Stack gap="md">
				<Stack gap="xs">
					<Group gap="sm" align="center">
						<Title order={4}>{recipe.name}</Title>
						{latestRun && <RunStatusBadge status={latestRun.status} />}
					</Group>
					<Text size="sm" c="dimmed">
						{recipe.purpose}
					</Text>
				</Stack>
				<Group gap="xs">
					{recipe.outputTypes.map((type) => (
						<Badge key={type} color="gray">
							{labels[type] ?? type}
						</Badge>
					))}
				</Group>
				<Accordion>
					<Accordion.Item value="inputs">
						<Accordion.Control>
							<Trans>Inputs and instructions</Trans>
						</Accordion.Control>
						<Accordion.Panel>
							<Stack gap="sm">
								{isConversationScoped ? (
									<Select
										searchable
										clearable
										label={t`Source conversation`}
										placeholder={t`Choose a conversation`}
										value={conversationId}
										onChange={setConversationId}
										data={sources.map((source) => ({
											label:
												source.participant_name?.trim() ||
												dateLabel(source.created_at),
											value: source.id,
										}))}
									/>
								) : (
									<Text>
										<Trans>
											Uses eligible conversations across this project.
										</Trans>
									</Text>
								)}
								<RecipeParameters
									recipe={recipe}
									values={parameters}
									onChange={setParameter}
								/>
							</Stack>
						</Accordion.Panel>
					</Accordion.Item>
					<Accordion.Item value="advanced">
						<Accordion.Control>
							<Trans>Advanced details</Trans>
						</Accordion.Control>
						<Accordion.Panel>
							<Stack gap="sm">
								<Title order={5}>
									<Trans>Read-only steps</Trans>
								</Title>
								<Stack gap={0} style={ruledList}>
									{recipe.steps.map((step) => (
										<Box py="sm" style={ruledRow} key={step.key}>
											<Text>{step.description}</Text>
											<Text size="xs" c="dimmed">
												{step.kind} ·{" "}
												{step.promptRef ?? step.checkVersion ?? step.key}
											</Text>
										</Box>
									))}
								</Stack>
								<Title order={5}>
									<Trans>Checks</Trans>
								</Title>
								{recipe.validationRules.length ? (
									recipe.validationRules.map((rule) => (
										<Text size="sm" key={rule}>
											{rule}
										</Text>
									))
								) : (
									<Text size="sm">
										<Trans>No recipe checks declared.</Trans>
									</Text>
								)}
							</Stack>
						</Accordion.Panel>
					</Accordion.Item>
				</Accordion>
				{recipe.id === "popcorn" && (
					<PopcornVoiceRecipeSettings
						projectId={projectId}
						popcorn={popcorn}
						canEdit={canRun}
					/>
				)}
				{request.isError && <ErrorNotice error={request.error} />}
				<Group>
					{canRun && (
						<Button
							onClick={run}
							loading={request.isPending}
							disabled={isActive || (isConversationScoped && !conversationId)}
						>
							{isActive ? t`Preparing` : actionLabel}
						</Button>
					)}
					<Button onClick={onShowResults}>
						<Trans>View results</Trans>
					</Button>
				</Group>
				{canRun && (
					<Accordion>
						<Accordion.Item value="run-again">
							<Accordion.Control>
								<Trans>Run again from scratch</Trans>
							</Accordion.Control>
							<Accordion.Panel>
								<Stack gap="sm">
									<Text size="sm">
										<Trans>
											Run this recipe again for {scopeLabel}. Existing published
											results stay visible until the fresh generation is ready.
										</Trans>
									</Text>
									<Button
										w="fit-content"
										onClick={runFresh}
										loading={request.isPending}
										disabled={
											isActive || (isConversationScoped && !conversationId)
										}
									>
										<Trans>Regenerate</Trans>
									</Button>
								</Stack>
							</Accordion.Panel>
						</Accordion.Item>
					</Accordion>
				)}
			</Stack>
		</Card>
	);
}

function RecipesView({
	projectId,
	recipeId,
}: {
	projectId: string;
	recipeId?: string;
}) {
	const recipes = useAnalysisRecipes();
	const runs = useAnalysisRuns(projectId);
	const needsPopcornVoice = Boolean(
		recipes.data?.some((recipe) => recipe.id === "popcorn"),
	);
	const popcorn = useProjectPopcorn(projectId, needsPopcornVoice);
	const needsSources = Boolean(
		recipes.data?.some((recipe) =>
			recipe.scopeKeyPattern.includes("conversation:"),
		),
	);
	const sources = useAnalysisSources(projectId, needsSources);
	const [params, setParams] = useSearchParams();
	if (
		recipes.isLoading ||
		runs.isLoading ||
		(needsSources && sources.isLoading) ||
		(needsPopcornVoice && popcorn.isLoading)
	)
		return <LoadingBlocks />;
	if (recipes.isError || runs.isError || sources.isError || popcorn.isError)
		return (
			<div {...testId("analysis-recipes-error")}>
				<ErrorNotice
					title={t`Recipes could not be loaded.`}
					error={recipes.error ?? runs.error ?? sources.error ?? popcorn.error}
					onRetry={() => {
						if (recipes.isError) void recipes.refetch();
						if (runs.isError) void runs.refetch();
						if (sources.isError) void sources.refetch();
						if (popcorn.isError) void popcorn.refetch();
					}}
				/>
			</div>
		);
	const visible = recipeId
		? recipes.data?.filter((recipe) => recipe.id === recipeId)
		: recipes.data;
	return (
		<Stack gap="lg">
			{visible?.map((recipe) => (
				<RecipeCard
					key={recipe.id}
					recipe={recipe}
					runs={runs.data?.runs ?? []}
					projectId={projectId}
					sources={sources.data ?? []}
					popcorn={popcorn.data?.popcorn}
					canRun={Boolean(runs.data?.canRun)}
					onShowResults={() => {
						const next = new URLSearchParams(params);
						next.set("tab", "results");
						if (recipe.outputTypes.length === 1)
							next.set("type", recipe.outputTypes[0]);
						setParams(next);
					}}
				/>
			))}
		</Stack>
	);
}

function RunDetail({
	runId,
	projectId,
	canCancel,
	onClose,
}: {
	runId: string;
	projectId: string;
	canCancel: boolean;
	onClose: () => void;
}) {
	const detail = useAnalysisRun(runId);
	const cancel = useCancelAnalysisRun(projectId);
	if (detail.isLoading) return <LoadingBlocks />;
	if (!detail.data)
		return detail.error ? (
			<ErrorNotice
				title={t`Run details could not be loaded.`}
				error={detail.error}
				onRetry={() => detail.refetch()}
			/>
		) : (
			<Alert color="red">
				<Trans>Run details could not be loaded.</Trans>
			</Alert>
		);
	const run = detail.data;
	const inputRevisions = run.inputs.revisions;
	const outputObjects = run.output?.objects ?? 0;
	const confirmStop = () =>
		openConfirm({
			title: t`Stop run?`,
			danger: true,
			labels: { confirm: t`Stop run` },
			onConfirm: () => cancel.mutate(run.id),
		});
	return (
		<Paper withBorder p="lg">
			<Stack gap="md">
				<Stack gap="xs">
					<Title order={4}>{run.recipeId}</Title>
					<Group gap="sm">
						<RunStatusBadge status={run.status} />
						<Text size="sm" c="dimmed">
							{dateLabel(run.createdAt)}
						</Text>
					</Group>
				</Stack>
				{run.error && <Alert color="red">{run.error}</Alert>}
				<Text>
					<Trans>Inputs: {inputRevisions}</Trans>
				</Text>
				<Text>
					<Trans>Output objects: {outputObjects}</Trans>
				</Text>
				<Accordion>
					<Accordion.Item value="steps">
						<Accordion.Control>
							<Trans>Steps and logs</Trans>
						</Accordion.Control>
						<Accordion.Panel>
							<Text component="pre" size="xs" className="whitespace-pre-wrap">
								{JSON.stringify(run.steps ?? [], null, 2)}
							</Text>
						</Accordion.Panel>
					</Accordion.Item>
					<Accordion.Item value="checks">
						<Accordion.Control>
							<Trans>Checks</Trans>
						</Accordion.Control>
						<Accordion.Panel>
							<Text component="pre" size="xs" className="whitespace-pre-wrap">
								{JSON.stringify(run.checks, null, 2)}
							</Text>
						</Accordion.Panel>
					</Accordion.Item>
				</Accordion>
				<Group gap="sm" justify="flex-start">
					{canCancel && activeStatuses.has(run.status) && (
						<Button onClick={confirmStop} loading={cancel.isPending}>
							<Trans>Stop run</Trans>
						</Button>
					)}
					<Button variant="subtle" color="gray" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}

function RunsView({ projectId }: { projectId: string }) {
	const runs = useAnalysisRuns(projectId);
	const [selected, setSelected] = useState<string>();
	if (runs.isLoading) return <LoadingBlocks />;
	if (runs.isError)
		return (
			<div {...testId("analysis-runs-error")}>
				<ErrorNotice
					title={t`Run history could not be loaded.`}
					error={runs.error}
					onRetry={() => runs.refetch()}
				/>
			</div>
		);
	if (selected)
		return (
			<RunDetail
				runId={selected}
				projectId={projectId}
				canCancel={Boolean(runs.data?.canRun)}
				onClose={() => setSelected(undefined)}
			/>
		);
	return (
		<Stack gap={0}>
			{runs.data?.runs.length === 0 && (
				<Text size="sm" c="dimmed">
					<Trans>No runs yet. Preparation and updates will appear here.</Trans>
				</Text>
			)}
			{runs.data?.runs.map((run) => (
				<EntityListRow
					key={run.id}
					onActivate={() => setSelected(run.id)}
				>
					<Stack gap="xs">
						<Group gap="sm">
							<Text>{run.recipeId}</Text>
							<RunStatusBadge status={run.status} />
						</Group>
						<Text size="sm" c="dimmed">
							{dateLabel(run.createdAt)}
						</Text>
					</Stack>
				</EntityListRow>
			))}
		</Stack>
	);
}

export function ProjectAnalysisRoute() {
	const {
		projectId,
		workspaceId,
		tab: pathTab,
		recipeId,
	} = useParams<{
		projectId: string;
		workspaceId?: string;
		tab?: string;
		recipeId?: string;
	}>();
	const [params, setParams] = useSearchParams();
	useDocumentTitle(t`Analysis | dembrane`);
	useAnalysisEvents(projectId ?? "");
	if (!projectId) return null;
	const requested =
		params.get("tab") ?? pathTab ?? (recipeId ? "recipes" : undefined);
	const tab: AnalysisTab =
		requested === "recipes" || requested === "runs" ? requested : "results";
	const projectPath = workspaceId
		? `/w/${workspaceId}/projects/${projectId}`
		: `/projects/${projectId}`;
	const section = params.get("section");
	// From the results panel the way back is the results panel; from the
	// presentation editor it is the editor's section.
	const returnPath =
		section === "results"
			? `${projectPath}/present?results=1`
			: `${projectPath}/present?edit=1${section ? `&section=${encodeURIComponent(section)}` : ""}`;
	return (
		<PageContainer width="xl">
			<Stack gap="xl">
				<Stack gap="md" align="flex-start">
					<Stack gap="xs">
						<Title order={2}>
							<Trans>Analysis</Trans>
						</Title>
						<Text c="dimmed">
							<Trans>
								Read shared findings, inspect their evidence and see how they
								were produced.
							</Trans>
						</Text>
					</Stack>
					{params.get("returnTo") === "present" && (
						<Button component={I18nLink} to={returnPath}>
							<Trans>Return to presentation</Trans>
						</Button>
					)}
				</Stack>
				<Tabs
					value={tab}
					onChange={(value) => {
						const next = new URLSearchParams(params);
						next.set("tab", value ?? "results");
						setParams(next, { replace: true });
					}}
				>
					<Tabs.List>
						<Tabs.Tab value="results">
							<Trans>Results</Trans>
						</Tabs.Tab>
						<Tabs.Tab value="recipes">
							<Trans>Recipes</Trans>
						</Tabs.Tab>
						<Tabs.Tab value="runs">
							<Trans>Runs</Trans>
						</Tabs.Tab>
					</Tabs.List>
					<Tabs.Panel value="results" pt="lg">
						<ResultsView projectId={projectId} workspaceId={workspaceId} />
					</Tabs.Panel>
					<Tabs.Panel value="recipes" pt="lg">
						<RecipesView projectId={projectId} recipeId={recipeId} />
					</Tabs.Panel>
					<Tabs.Panel value="runs" pt="lg">
						<RunsView projectId={projectId} />
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</PageContainer>
	);
}
