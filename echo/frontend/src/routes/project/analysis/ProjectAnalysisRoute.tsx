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
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { AnalysisResultsList } from "@/components/analysis/AnalysisResultsList";
import { EvidenceInspectionDrawer } from "@/components/analysis/EvidenceInspectionDrawer";
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
import { PageContainer } from "@/components/layout/PageContainer";
import {
	type PopcornDetail,
	useCreatePopcornMutation,
	useProjectPopcorn,
} from "@/components/popcorn/hooks";
import { PopcornVoiceSection } from "@/components/popcorn/PopcornVoiceSection";

type AnalysisTab = "results" | "recipes" | "runs";
const resultTypes = [
	"argument",
	"deduplicated_argument",
	"popcorn",
	"tension",
	"stakeholder",
];
const activeStatuses = new Set(["queued", "running", "waiting_for_inputs"]);
const resultTypeLabels: Record<string, string> = {
	argument: "Arguments",
	deduplicated_argument: "Consolidated arguments",
	popcorn: "Popcorn phrases",
	stakeholder: "Stakeholders",
	tension: "Tensions",
};

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
	const parsedPage = Number(params.get("page") ?? "1");
	const page =
		Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
	const objects = useAnalysisObjects(
		projectId,
		type,
		membership,
		(page - 1) * 100,
	);
	const [selected, setSelected] = useState<AnalysisObject | null>(null);
	const data = objects.data;
	const mapPath = workspaceId
		? `/w/${workspaceId}/projects/${projectId}/map`
		: `/projects/${projectId}/map`;
	return (
		<Stack gap="lg">
			<Paper withBorder radius="sm" p="sm">
				<Group justify="space-between" align="end" gap="sm">
					<Group align="end" gap="sm">
						<Select
							label={t`Result type`}
							clearable
							value={type ?? null}
							data={resultTypes.map((value) => ({
								label: resultTypeLabels[value],
								value,
							}))}
							onChange={(value) => {
								const next = new URLSearchParams(params);
								value ? next.set("type", value) : next.delete("type");
								next.delete("page");
								setParams(next, { replace: true });
							}}
						/>
						<Select
							label={t`Membership`}
							value={membership}
							data={[
								{ label: t`Current`, value: "active" },
								{ label: t`Withdrawn`, value: "withdrawn" },
								{ label: t`All`, value: "all" },
							]}
							onChange={(value) => {
								const next = new URLSearchParams(params);
								value && value !== "active"
									? next.set("membership", value)
									: next.delete("membership");
								next.delete("page");
								setParams(next, { replace: true });
							}}
						/>
					</Group>
					<Button component={Link} to={mapPath} variant="outline">
						<Trans>Open Map</Trans>
					</Button>
				</Group>
			</Paper>
			{objects.isLoading && <Loader />}
			{objects.isError && (
				<Alert color="red" variant="outline">
					<Trans>Results could not be loaded.</Trans>
				</Alert>
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
			{data && data.total > 0 && (
				<AnalysisResultsList
					counts={data.counts}
					items={data.items}
					labels={resultTypeLabels}
					limit={data.limit}
					onInspect={setSelected}
					onPageChange={(nextPage) => {
						const next = new URLSearchParams(params);
						nextPage === 1
							? next.delete("page")
							: next.set("page", String(nextPage));
						setParams(next);
					}}
					page={page}
					total={data.total}
				/>
			)}
			<EvidenceInspectionDrawer
				projectId={projectId}
				workspaceId={workspaceId}
				snapshotId={data?.snapshotId}
				item={selected}
				editable={Boolean(data?.canEdit)}
				opened={Boolean(selected)}
				onClose={() => setSelected(null)}
			/>
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
			{properties.map(([name, schema]) => (
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
						{schema.minimum !== undefined && (
							<Badge variant="outline">min {String(schema.minimum)}</Badge>
						)}
						{schema.maximum !== undefined && (
							<Badge variant="outline">max {String(schema.maximum)}</Badge>
						)}
					</Group>
				</Paper>
			))}
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
	const [parameters, setParameters] =
		useState<Record<string, unknown>>(defaults);
	const scopeKey =
		isConversationScoped && conversationId
			? `conversation:${conversationId}`
			: "project";
	const latestRun = runs.find(
		(run) => run.recipeId === recipe.id && run.scopeKey === scopeKey,
	);
	useEffect(() => {
		setParameters({ ...defaults, ...(latestRun?.parameters ?? {}) });
	}, [defaults, latestRun]);
	const isFailed = latestRun?.status === "failed";
	const isActive = Boolean(latestRun && activeStatuses.has(latestRun.status));
	const actionLabel = !latestRun
		? t`Prepare`
		: isFailed
			? t`Try again`
			: t`Update results`;
	const run = () =>
		request.mutate({
			mode: isFailed ? "retry" : "refresh",
			parameters,
			recipe_id: recipe.id,
			retry_run_id: isFailed ? latestRun?.id : undefined,
			scope_key: scopeKey,
		});
	const runFresh = () =>
		request.mutate({
			mode: "regenerate",
			parameters,
			recipe_id: recipe.id,
			scope_key: scopeKey,
		});
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
							{resultTypeLabels[type] ?? type}
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
									onChange={(name, value) =>
										setParameters((current) => ({ ...current, [name]: value }))
									}
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
										Run this recipe again for {scopeLabel}. Existing published
										results stay visible until the fresh generation is ready.
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
			<Alert color="red" variant="outline">
				<Trans>Recipes could not be loaded.</Trans>
			</Alert>
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
			<Alert color="red" variant="outline">
				<Trans>Run history could not be loaded.</Trans>
			</Alert>
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
	const returnPath = `${projectPath}/present?edit=1${section ? `&section=${encodeURIComponent(section)}` : ""}`;
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
						<Button component={Link} to={returnPath} variant="outline">
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
