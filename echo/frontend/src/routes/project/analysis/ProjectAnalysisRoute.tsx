import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	Alert,
	Badge,
	Button,
	Card,
	Group,
	Loader,
	NumberInput,
	Paper,
	Select,
	Stack,
	Switch,
	Tabs,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import {
	type AnalysisObject,
	type AnalysisRecipe,
	type AnalysisRun,
	type AnalysisSource,
	useAnalysisEvents,
	useAnalysisObjects,
	useAnalysisRecipes,
	useAnalysisRun,
	useAnalysisRuns,
	useAnalysisSources,
	useCancelAnalysisRun,
	useRequestAnalysisRun,
} from "@/components/analysis/hooks";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { I18nLink } from "@/components/common/i18nLink";
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
	if (status === "failed" || status === "cancelled") return "red";
	if (activeStatuses.has(status)) return "primary";
	return "gray";
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
	const objects = useAnalysisObjects(projectId, type, membership);
	const [selected, setSelected] = useState<AnalysisObject | null>(null);
	const actions = useResultActions({ projectId });
	const data = objects.data;
	const mapPath = workspaceId
		? `/w/${workspaceId}/projects/${projectId}/map`
		: `/projects/${projectId}/map`;
	// The filter row writes to the address, like every other filter here.
	const write = (next: URLSearchParams) => setParams(next, { replace: true });
	return (
		<Stack gap="lg">
			<Group justify="end">
				<Button component={I18nLink} to={mapPath} variant="outline">
					<Trans>Open Map</Trans>
				</Button>
			</Group>
			{objects.isError && (
				<FetchErrorPanel
					onRetry={() => objects.refetch()}
					message={<Trans>Results could not be loaded.</Trans>}
					testId="analysis-results-error"
				/>
			)}
			{data && data.total === 0 && (
				<Paper withBorder p="xl">
					<Stack gap="sm">
						<Title order={3}>
							<Trans>No prepared results yet</Trans>
						</Title>
						<Text>
							<Trans>
								Open Recipes to prepare results from this project's eligible
								conversations.
							</Trans>
						</Text>
						<Button
							w="fit-content"
							variant="outline"
							onClick={() => {
								const next = new URLSearchParams(params);
								next.set("tab", "recipes");
								setParams(next);
							}}
						>
							<Trans>View recipes</Trans>
						</Button>
					</Stack>
				</Paper>
			)}
			{!objects.isError && (!data || data.total > 0) && (
				<ResultsList
					actions={actions}
					canEdit={Boolean(data?.canEdit)}
					counts={data?.counts}
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
					items={data?.items ?? []}
					loading={objects.isLoading}
					onOpen={(item) =>
						setSelected((current) =>
							current?.objectId === item.objectId ? null : item,
						)
					}
					openObjectId={selected?.objectId ?? null}
					renderItem={(item) => (
						<ResultItem
							canEdit={Boolean(data?.canEdit)}
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
		<Stack gap="xs">
			{properties.map(([name, schema]) => {
				const minimum =
					schema.minimum === undefined ? null : String(schema.minimum);
				const maximum =
					schema.maximum === undefined ? null : String(schema.maximum);
				return (
					<Paper key={name} withBorder p="sm">
						<Text fw={600}>{name}</Text>
						<Text size="sm">
							{String(schema.description ?? schema.title ?? schema.type ?? "")}
						</Text>
						<Group gap="xs">
							{schema.default !== undefined && (
								<Badge variant="outline">
									<Trans>Default</Trans>: {String(schema.default)}
								</Badge>
							)}
							{minimum !== null && (
								<Badge variant="outline">
									<Trans>min {minimum}</Trans>
								</Badge>
							)}
							{maximum !== null && (
								<Badge variant="outline">
									<Trans>max {maximum}</Trans>
								</Badge>
							)}
						</Group>
					</Paper>
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
				<Text size="sm">
					<Trans>
						Create the presentation settings to choose how Popcorn phrases
						should sound. This does not prepare any results.
					</Trans>
				</Text>
				<Button
					variant="outline"
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
				<Group justify="space-between" align="start">
					<Stack gap={2}>
						<Title order={3}>{recipe.name}</Title>
						<Text size="sm">{recipe.purpose}</Text>
					</Stack>
					{latestRun && (
						<Badge color={statusColor(latestRun.status)} variant="outline">
							{latestRun.status}
						</Badge>
					)}
				</Group>
				<Group gap="xs">
					{recipe.outputTypes.map((type) => (
						<Badge key={type} variant="outline">
							{labels[type] ?? type}
						</Badge>
					))}
				</Group>
				<Accordion variant="contained">
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
								<Title order={4}>
									<Trans>Read-only steps</Trans>
								</Title>
								{recipe.steps.map((step) => (
									<Paper withBorder p="sm" key={step.key}>
										<Text fw={600}>{step.description}</Text>
										<Text size="xs">
											{step.kind} ·{" "}
											{step.promptRef ?? step.checkVersion ?? step.key}
										</Text>
									</Paper>
								))}
								<Title order={4}>
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
				{request.isError && (
					<Alert color="red" variant="outline">
						{request.error.message}
					</Alert>
				)}
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
					<Button variant="outline" onClick={onShowResults}>
						<Trans>View results</Trans>
					</Button>
				</Group>
				{canRun && (
					<Accordion variant="contained">
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
										variant="outline"
										w="fit-content"
										onClick={runFresh}
										loading={request.isPending}
										disabled={
											isActive || (isConversationScoped && !conversationId)
										}
									>
										<Trans>Run fresh generation</Trans>
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
		return <Loader />;
	if (recipes.isError || runs.isError || sources.isError || popcorn.isError)
		return (
			<FetchErrorPanel
				onRetry={() => {
					if (recipes.isError) void recipes.refetch();
					if (runs.isError) void runs.refetch();
					if (sources.isError) void sources.refetch();
					if (popcorn.isError) void popcorn.refetch();
				}}
				message={<Trans>Recipes could not be loaded.</Trans>}
				testId="analysis-recipes-error"
			/>
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
	if (detail.isLoading) return <Loader />;
	if (!detail.data)
		return (
			<Alert color="red" variant="outline">
				<Trans>Run details could not be loaded.</Trans>
			</Alert>
		);
	const run = detail.data;
	return (
		<Paper withBorder p="lg">
			<Stack gap="md">
				<Group justify="space-between">
					<Title order={3}>{run.recipeId}</Title>
					<Button variant="subtle" onClick={onClose}>
						<Trans>Close details</Trans>
					</Button>
				</Group>
				<Group>
					<Badge color={statusColor(run.status)} variant="outline">
						{run.status}
					</Badge>
					<Text size="sm">{dateLabel(run.createdAt)}</Text>
				</Group>
				{run.error && (
					<Alert color="red" variant="outline">
						{run.error}
					</Alert>
				)}
				<Text>
					<Trans>Inputs</Trans>: {run.inputs.revisions}
				</Text>
				<Text>
					<Trans>Output objects</Trans>: {run.output?.objects ?? 0}
				</Text>
				<Accordion variant="contained">
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
				{canCancel && activeStatuses.has(run.status) && (
					<Button
						color="red"
						variant="outline"
						w="fit-content"
						onClick={() => cancel.mutate(run.id)}
						loading={cancel.isPending}
					>
						<Trans>Stop run</Trans>
					</Button>
				)}
			</Stack>
		</Paper>
	);
}

function RunsView({ projectId }: { projectId: string }) {
	const runs = useAnalysisRuns(projectId);
	const [selected, setSelected] = useState<string>();
	if (runs.isLoading) return <Loader />;
	if (runs.isError)
		return (
			<FetchErrorPanel
				onRetry={() => runs.refetch()}
				message={<Trans>Run history could not be loaded.</Trans>}
				testId="analysis-runs-error"
			/>
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
		<Stack gap="sm">
			{runs.data?.runs.length === 0 && (
				<Paper withBorder p="xl">
					<Title order={3}>
						<Trans>No runs yet</Trans>
					</Title>
					<Text>
						<Trans>Preparation and updates will appear here.</Trans>
					</Text>
				</Paper>
			)}
			{runs.data?.runs.map((run) => (
				<Card
					withBorder
					key={run.id}
					onClick={() => setSelected(run.id)}
					className="cursor-pointer"
				>
					<Group justify="space-between">
						<Stack gap={2}>
							<Text fw={600}>{run.recipeId}</Text>
							<Text size="sm">{dateLabel(run.createdAt)}</Text>
						</Stack>
						<Badge color={statusColor(run.status)} variant="outline">
							{run.status}
						</Badge>
					</Group>
				</Card>
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
				<Group justify="space-between" align="start">
					<Stack gap="xs">
						<Title order={1}>
							<Trans>Analysis</Trans>
						</Title>
						<Text>
							<Trans>
								Read shared findings, inspect their evidence and see how they
								were produced.
							</Trans>
						</Text>
					</Stack>
					{params.get("returnTo") === "present" && (
						<Button component={I18nLink} to={returnPath} variant="outline">
							<Trans>Return to presentation</Trans>
						</Button>
					)}
				</Group>
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
