import { plural, t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Checkbox,
	Group,
	Select,
	Skeleton,
	Stack,
	Switch,
	Tabs,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { ArrowSquareOutIcon, MonitorIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useParams, useSearchParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { SaveStatus } from "@/components/form/SaveStatus";
import { PageContainer } from "@/components/layout/PageContainer";
import { readAfterFinish } from "@/components/popcorn/finishedRead";
import {
	liveBooking,
	usePopcornLiveMutation,
	usePopcornSettingsMutation,
	usePopcornStopLiveMutation,
} from "@/components/popcorn/hooks";
import {
	PopcornAlsoLanguages,
	PopcornLanguageSettings,
} from "@/components/popcorn/PopcornLanguageSettings";
import { PopcornOpeningSettings } from "@/components/popcorn/PopcornOpeningSettings";
import {
	PopcornLabelsSwitch,
	PopcornScreenSettings,
} from "@/components/popcorn/PopcornScreenSettings";
import { PopcornShare } from "@/components/popcorn/PopcornShare";
import {
	SettingsSaveContext,
	useSettingsFlush,
} from "@/components/popcorn/SettingsSaveContext";
import {
	AudienceScreen,
	type AudienceScreenProps,
} from "@/components/present/AudienceScreen";
import {
	ALWAYS_ON_BLOCK,
	blocksPatch,
	orderedBlocks,
	PRESENTATION_BLOCKS,
	type PresentationBlock,
} from "@/components/present/blocks";
import {
	type Presentation,
	presentationKey,
	useEnsurePresentation,
	usePresentation,
} from "@/components/present/hooks";
import {
	countChangedFields,
	presentationDraftKey,
	usePresentationDraft,
} from "@/components/present/hooks/usePresentationDraft";
import { useRoomScreenOpen } from "@/components/present/hooks/useRoomScreen";
import { TranslationStatus } from "@/components/present/TranslationStatus";
import { HostGuideSettings } from "@/components/sharing/HostGuideSettings";
import { PresentButton } from "@/components/sharing/PresentButton";
import { EventPrintoutsItem, ShareButton } from "@/components/sharing/Share";
import { StatusLine } from "@/components/sharing/StatusLine";
import { API_BASE_URL } from "@/config";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useServerEvents } from "@/hooks/useServerEvents";
import { bff } from "@/lib/bff";
import { errorCode } from "@/lib/errors/read";
import { testId } from "@/lib/testUtils";
import { blockLabel } from "./blockLabel";
import { PresentResultsPanel } from "./PresentResultsPanel";
import classes from "./PresentRoute.module.css";

// One event stream per presentation page: the embedded preview follows the
// page's, counted here, and opens none of its own.
const PresentationEventTick = createContext(0);

// The virtual size of the room's screen. The preview renders at this size and
// is scaled down, so nothing reflows or clips at the column's width.
const STAGE_WIDTH = 1440;
const STAGE_HEIGHT = 810;

// The presentation panel: the style and structure of the screen. What the
// screen says is reviewed in its sibling, the results panel.
function Editor({
	projectId,
	presentation,
}: {
	projectId: string;
	presentation: Presentation;
}) {
	const [params, setParams] = useSearchParams();
	const save = usePopcornSettingsMutation(projectId, presentation.id);
	const selected = orderedBlocks([
		...(presentation.settings.presentation?.blocks ?? []),
		ALWAYS_ON_BLOCK,
	]);
	const section = editorSection(params);
	const setSection = (value: string | null) =>
		setParams((old) => {
			const next = new URLSearchParams(old);
			next.set("section", value ?? "activities");
			return next;
		});
	const sections = [
		{ label: t`Intro`, value: "intro" },
		{ label: t`Data policy`, value: "data" },
		{ label: t`Host guide`, value: "guide" },
		{ label: t`Outcomes`, value: "activities" },
		{ label: t`Language`, value: "language" },
		{ label: t`Appearance`, value: "appearance" },
	];
	// Where the tabs don't fit (a phone, the side column), the row changes as a
	// whole into one drop-down naming the current section. The row stays laid
	// out, unseen, so it can tell when there is room for it again.
	const tabList = useRef<HTMLDivElement>(null);
	const [collapsed, setCollapsed] = useState(false);
	useLayoutEffect(() => {
		const list = tabList.current;
		if (!list || typeof ResizeObserver === "undefined") return;
		const measure = () => setCollapsed(list.scrollWidth > list.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		return () => observer.disconnect();
	}, []);
	return (
		<Stack className={classes.settings} gap="lg">
			<Title order={4}>
				<Trans>Presentation editor</Trans>
			</Title>
			<PresentationTitle projectId={projectId} presentation={presentation} />
			<Tabs value={section} onChange={setSection} className={classes.tabs}>
				{collapsed && (
					<Select
						aria-label={t`Editor section`}
						data={sections}
						value={section}
						allowDeselect={false}
						onChange={setSection}
					/>
				)}
				<Tabs.List
					ref={tabList}
					className={collapsed ? classes.unseen : undefined}
					aria-hidden={collapsed || undefined}
				>
					{sections.map(({ label, value }) => (
						<Tabs.Tab key={value} value={value}>
							{label}
						</Tabs.Tab>
					))}
				</Tabs.List>
				<Tabs.Panel value="intro" pt="md">
					<PopcornOpeningSettings
						projectId={projectId}
						popcorn={presentation}
						section="intro"
					/>
				</Tabs.Panel>
				<Tabs.Panel value="data" pt="md">
					<Stack gap="md">
						<PopcornOpeningSettings
							projectId={projectId}
							popcorn={presentation}
							section="data"
						/>
						<PopcornLabelsSwitch projectId={projectId} popcorn={presentation} />
					</Stack>
				</Tabs.Panel>
				<Tabs.Panel value="guide" pt="md">
					<HostGuideSettings
						projectId={projectId}
						presentation={presentation}
					/>
				</Tabs.Panel>
				<Tabs.Panel value="activities" pt="md">
					<Stack>
						<Text size="sm" c="dimmed">
							<Trans>Choose the outcomes your audience can explore.</Trans>
						</Text>
						{PRESENTATION_BLOCKS.map((block) => {
							const locked = block === ALWAYS_ON_BLOCK;
							return (
								<Switch
									key={block}
									label={blockLabel(block)}
									description={
										locked
											? t`Always on. The screen opens here, so the room has something to read while the rest gets ready.`
											: {
													map: t`Ideas and how they connect`,
													popcorn: t`Short phrases from the conversations`,
													stakeholders: t`People, groups and what matters to them`,
													tensions: t`Different perspectives and trade-offs`,
												}[block]
									}
									checked={locked || selected.includes(block)}
									readOnly={locked}
									onChange={(event) => {
										if (locked) return;
										save.mutate({
											presentation: blocksPatch(
												selected,
												block,
												event.currentTarget.checked,
											),
										});
									}}
									styles={{
										body: {
											flexDirection: "row-reverse",
											gap: "var(--mantine-spacing-md)",
											justifyContent: "space-between",
										},
										labelWrapper: { paddingLeft: 0 },
										track: { flexShrink: 0 },
									}}
								/>
							);
						})}
					</Stack>
				</Tabs.Panel>
				<Tabs.Panel value="language" pt="md">
					<Stack gap="sm">
						<Checkbox
							label={t`Follow project language`}
							checked={
								presentation.settings.presentation?.language_policy ===
								"project"
							}
							onChange={(e) =>
								save.mutate({
									presentation: {
										language_policy: e.currentTarget.checked
											? "project"
											: "explicit",
									},
									...(!e.currentTarget.checked
										? { language: presentation.effective_language }
										: {}),
								})
							}
						/>
						<Text size="sm">
							<Trans>Audience language:</Trans>{" "}
							{presentation.effective_language.translate_to ||
								presentation.effective_language.ui}
							{presentation.project_language.fallback &&
							presentation.settings.presentation?.language_policy === "project"
								? ` · ${t`English fallback`}`
								: ""}
						</Text>
						{presentation.settings.presentation?.language_policy !==
						"project" ? (
							// The embedded settings carry the translation line themselves.
							<PopcornLanguageSettings
								embedded
								projectId={projectId}
								popcorn={presentation}
							/>
						) : (
							<>
								<PopcornAlsoLanguages
									projectId={projectId}
									popcorn={presentation}
									language={presentation.effective_language}
								/>
								<TranslationStatus
									presentationId={presentation.id}
									status={presentation.translation_status}
								/>
							</>
						)}
					</Stack>
				</Tabs.Panel>
				<Tabs.Panel value="appearance" pt="md">
					<PopcornScreenSettings
						embedded
						projectId={projectId}
						popcorn={presentation}
						showToolToggles={false}
						showLabelsToggle={false}
					/>
				</Tabs.Panel>
			</Tabs>
		</Stack>
	);
}

// Outcomes keeps its old value, `activities`, so links that name it still
// land there. Anything else unknown, including `?section=results` (a tab of
// the editor once, now the results panel), falls back to it.
const EDITOR_SECTIONS = [
	"intro",
	"data",
	"guide",
	"activities",
	"language",
	"appearance",
];
function editorSection(params: URLSearchParams) {
	const section = params.get("section") ?? "";
	return EDITOR_SECTIONS.includes(section) ? section : "activities";
}

// The draft on the room's screen. Typing into its opening saves like any other
// field of the draft.
function DraftPreview({
	projectId,
	presentation,
	revision,
	block,
	notShown,
}: {
	projectId: string;
	presentation: Presentation;
	revision: number;
	/** The tab the results panel below is on, so the preview shows the same. */
	block?: PresentationBlock | null;
	notShown: boolean;
}) {
	const save = usePopcornSettingsMutation(projectId, presentation.id);
	return (
		<Preview
			block={block}
			notShown={notShown}
			presentation={presentation}
			draft
			revision={revision}
			onEditOpening={save.mutateAsync}
		/>
	);
}

function PresentationTitle({
	projectId,
	presentation,
}: {
	projectId: string;
	presentation: Presentation;
}) {
	const save = usePopcornSettingsMutation(projectId, presentation.id);
	const [title, setTitle] = useState(presentation.settings.title);
	const autosave = useAutoSave<string>({
		onSave: async (value) => {
			if (!value.trim()) throw new Error("A presentation title is required.");
			await save.mutateAsync({ title: value.trim() });
		},
	});
	useSettingsFlush(async () => {
		if (autosave.isPendingSave && !(await autosave.triggerManualSave(title)))
			throw new Error("Title could not be saved.");
	}, autosave.isPendingSave);
	return (
		<TextInput
			label={t`Presentation title`}
			value={title}
			maxLength={160}
			error={!title.trim() ? t`Enter a presentation title` : undefined}
			onChange={(event) => {
				setTitle(event.currentTarget.value);
				autosave.dispatchAutoSave(event.currentTarget.value);
			}}
		/>
	);
}

function Preview({
	presentation,
	draft = false,
	revision = 0,
	onEditOpening,
	block,
	notShown = false,
}: {
	presentation: Presentation;
	draft?: boolean;
	revision?: number;
	onEditOpening?: AudienceScreenProps["onEditOpening"];
	block?: PresentationBlock | null;
	/** The draft holds changes the room's screen isn't showing yet. */
	notShown?: boolean;
}) {
	const eventTick = useContext(PresentationEventTick);
	// The room's screen at its own size, shrunk to fit the column. At the
	// column's width the real screen would run its title into its tabs and clip
	// them; scaled, the host sees what the room will see.
	const { ref, width } = useElementSize();
	return (
		<div className={classes.preview}>
			<Group px="md" py="sm" gap="xs">
				<MonitorIcon size={16} />
				<Text size="sm">
					<Trans>Audience preview</Trans>
				</Text>
				{notShown && (
					<>
						<Text size="sm" c="dimmed" aria-hidden>
							·
						</Text>
						<Text size="sm" c="dimmed">
							<Trans>Not on the room screen yet</Trans>
						</Text>
					</>
				)}
			</Group>
			<div className={classes.viewport} ref={ref}>
				<div
					className={classes.stage}
					style={{
						height: STAGE_HEIGHT,
						transform: `scale(${width ? width / STAGE_WIDTH : 1})`,
						width: STAGE_WIDTH,
					}}
					{...testId("present-preview-stage")}
				>
					<AudienceScreen
						presentationId={presentation.id}
						block={block}
						embedded
						draft={draft}
						draftRevision={revision}
						eventTick={eventTick}
						onEditOpening={onEditOpening}
						className={classes.screen}
					/>
				</div>
			</div>
		</div>
	);
}

function Session({
	projectId,
	presentation,
	open,
	canEdit,
	opening,
}: {
	projectId: string;
	presentation: Presentation;
	open: () => void;
	canEdit: boolean;
	opening: boolean;
}) {
	const [params] = useSearchParams();
	const navigate = useI18nNavigate();
	const { workspaceId } = useParams();
	const client = useQueryClient();
	const updates = useQuery({
		queryFn: () =>
			bff.get<{ available: boolean }>(`/present/${presentation.id}/updates`),
		queryKey: [
			"presentation-updates",
			presentation.id,
			presentation.counts.run,
		],
	});
	const adopt = useMutation({
		mutationFn: () => bff.post(`/present/${presentation.id}/adopt`),
		onSuccess: () => {
			client.invalidateQueries({ queryKey: presentationKey(projectId) });
			client.invalidateQueries({
				queryKey: ["presentation-updates", presentation.id],
			});
		},
	});
	const live = usePopcornLiveMutation(projectId, presentation.id);
	const stop = usePopcornStopLiveMutation(projectId, presentation.id);
	const isLive = presentation.loop?.mode === "live";
	const booking = liveBooking(presentation.loop);
	const readAfter = readAfterFinish(presentation.loop);
	const [eventTick, setEventTick] = useState(0);
	useServerEvents(
		`${API_BASE_URL}/v2/bff/popcorn/${encodeURIComponent(presentation.id)}/events`,
		["update"],
		() => {
			setEventTick((tick) => tick + 1);
			client.invalidateQueries({ queryKey: presentationKey(projectId) });
			client.invalidateQueries({
				queryKey: ["presentation-updates", presentation.id],
			});
			// A read finishing changes what the draft reports too (translation
			// progress, counts). Only read it back when nothing is in flight: a
			// refetch over a queued edit would show the host a value they undid.
			const draftKey = presentationDraftKey(presentation.id);
			if (!client.isMutating({ mutationKey: draftKey }))
				client.invalidateQueries({ queryKey: draftKey });
		},
	);
	// A host who may edit always has both: the presentation editor and the
	// results panel are the dashboard, not a mode it can be put into. The
	// preview shows the draft.
	const drafting = canEdit;
	// While someone may be watching, edits wait in the draft until the host
	// shows them; otherwise each one goes straight to the screen. The first
	// reason that applies is the one the page gives.
	const roomOpen = useRoomScreenOpen(presentation.id);
	const isPublic = !!presentation.settings.public;
	const watchedBy = roomOpen
		? "screen"
		: isLive
			? "live"
			: isPublic
				? "public"
				: null;
	const draft = usePresentationDraft(
		projectId,
		presentation.id,
		// A host who may edit also types into the opening on the preview below.
		canEdit,
		{ showAsSaved: !watchedBy },
	);
	const flushers = useRef(new Set<() => Promise<void>>());
	const [pendingFields, setPendingFields] = useState(new Set<string>());
	const [publishing, setPublishing] = useState(false);
	const [publishError, setPublishError] = useState<unknown>(null);
	// The tab the results panel is on. The preview follows it, so choosing
	// "Tensions" to review them puts the room's own tensions slide beside the
	// list. Nothing here ever reaches the screen in the room.
	const [previewBlock, setPreviewBlock] = useState<PresentationBlock | null>(
		null,
	);
	// A field that leaves takes its unsaved words with it, so it writes them on
	// its way out: closing the editor used to be the moment for that, and the
	// editor no longer closes. Leaving the page unmounts the fields and this
	// runs for each of them; showing the changes still flushes them all first.
	const registerFlush = useCallback((flush: () => Promise<void>) => {
		flushers.current.add(flush);
		return () => {
			flushers.current.delete(flush);
			void flush().catch(() => {});
		};
	}, []);
	const setFieldPending = useCallback(
		(id: string, pending: boolean) =>
			setPendingFields((old) => {
				const next = new Set(old);
				if (pending) next.add(id);
				else next.delete(id);
				return next;
			}),
		[],
	);
	const settingsEditor = useMemo(
		() => ({
			registerFlush,
			save: async (
				patch: import("@/components/popcorn/hooks").PopcornSettingsPatch,
			) => (await draft.save.mutateAsync(patch)).presentation,
			setFieldPending,
		}),
		[draft.save.mutateAsync, registerFlush, setFieldPending],
	);
	// Share is a deliberate choice about who sees the presentation, so what is
	// set there shows at once, with anything else that was waiting.
	const shareEditor = useMemo(
		() => ({
			registerFlush,
			save: async (
				patch: import("@/components/popcorn/hooks").PopcornSettingsPatch,
			) => (await draft.saveAndShow(patch)).presentation,
			setFieldPending,
		}),
		[draft.saveAndShow, registerFlush, setFieldPending],
	);
	const changes = draft.query.data?.has_changes
		? countChangedFields(
				draft.query.data.presentation.settings,
				presentation.settings,
			)
		: 0;
	// Nobody watching: a change is on its way out, not waiting, until the
	// show after its save has had its turn.
	const settling =
		pendingFields.size > 0 ||
		draft.save.isPending ||
		draft.publish.isPending ||
		draft.showQueued;
	const waiting =
		canEdit &&
		!!draft.query.data?.has_changes &&
		(!!watchedBy || !settling || draft.publish.isError);
	const refused = draft.publish.error ?? publishError;
	// The one change a plan may refuse is a public link: say so, since it holds
	// every other waiting change back with it.
	const publicRefused =
		errorCode(refused) === "billing.tier_required" &&
		!!draft.query.data?.presentation.settings.public &&
		!presentation.settings.public;
	const publishChanges = async () => {
		setPublishing(true);
		setPublishError(null);
		try {
			for (const flush of flushers.current) await flush();
			await draft.publish.mutateAsync();
		} catch (error) {
			setPublishError(error);
		} finally {
			setPublishing(false);
		}
	};
	return (
		<PresentationEventTick.Provider value={eventTick}>
			<Stack gap="md">
				{/* One row, as on the map: the title and its status on the left,
				    the controls on the right. A phone stacks them. */}
				<Group
					gap="sm"
					align="center"
					justify="flex-start"
					wrap="nowrap"
					className="app-stack-narrow"
				>
					<Stack gap={4} className="min-w-0">
						<Group gap="sm" align="baseline" wrap="nowrap" className="min-w-0">
							<Title order={2}>
								<Trans>Present</Trans>
							</Title>
							<Text size="sm" c="dimmed" className="min-w-0 truncate">
								{presentation.name}
							</Text>
						</Group>
						<Group gap="xs" wrap="wrap">
							<StatusLine
								live={isLive}
								liveUntil={presentation.loop?.expires_at}
								booking={booking}
								isPublic={isPublic}
								extra={[
									...(waiting
										? [
												changes
													? plural(changes, {
															one: "# change not shown yet",
															other: "# changes not shown yet",
														})
													: t`Changes not shown yet`,
											]
										: []),
									...(readAfter ? [readAfter] : []),
								]}
							/>
							{waiting && (
								<>
									<Text size="sm" c="dimmed" aria-hidden>
										·
									</Text>
									<Button
										variant="subtle"
										size="compact-sm"
										onClick={() => void publishChanges()}
										loading={publishing}
										disabled={draft.save.isPending}
									>
										<Trans>Show them</Trans>
									</Button>
								</>
							)}
						</Group>
					</Stack>
					<Group
						gap="xs"
						ml="auto"
						className="shrink-0"
						aria-label={t`Presentation controls`}
					>
						{canEdit ? (
							<PresentButton
								live={isLive}
								booking={booking}
								opening={opening}
								pending={live.isPending || stop.isPending}
								onPresent={(hours) => {
									// The room screen opens in the click, or it is blocked.
									open();
									if (!isLive && !booking) live.mutate({ hours });
								}}
								onGoLive={(hours) => live.mutate({ hours })}
								onReadyBy={(hours, readyBy) => live.mutate({ hours, readyBy })}
								onStop={() => stop.mutate()}
							/>
						) : (
							<Button
								variant="filled"
								onClick={open}
								loading={opening}
								leftSection={<ArrowSquareOutIcon size={20} />}
							>
								<Trans>Present</Trans>
							</Button>
						)}
						{canEdit && (
							<ShareButton>
								{draft.query.data ? (
									<SettingsSaveContext.Provider value={shareEditor}>
										<fieldset
											disabled={publishing}
											style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
										>
											<Stack gap="md">
												<PopcornShare
													embedded
													projectId={projectId}
													popcorn={draft.query.data.presentation}
													presentation
													extras={
														<EventPrintoutsItem
															workspaceId={workspaceId ?? ""}
															projectId={projectId}
														/>
													}
												/>
												{/* A refused change is read where it was made. */}
												<ErrorNotice
													error={draft.publish.error}
													onRetry={() => void publishChanges()}
													title={t`Changes could not be shown on the room screen`}
												/>
											</Stack>
										</fieldset>
									</SettingsSaveContext.Provider>
								) : draft.query.isError ? (
									<ErrorNotice
										error={draft.query.error}
										onRetry={() => void draft.query.refetch()}
										title={t`The draft could not be loaded`}
									/>
								) : (
									<Stack
										gap="md"
										role="status"
										aria-label={t`Loading presentation`}
									>
										<Skeleton height={36} />
										<Skeleton height={200} />
									</Stack>
								)}
							</ShareButton>
						)}
					</Group>
				</Group>
				{/* Read where Show them was pressed. */}
				{canEdit && (
					<ErrorNotice
						error={refused}
						onRetry={() => void publishChanges()}
						title={
							publicRefused
								? t`A public page needs a higher plan. Switch Public page off under Share to show the other changes.`
								: t`Changes could not be shown on the room screen`
						}
					/>
				)}
				{drafting ? (
					draft.query.isError ? (
						<Box {...testId("present-draft-error-panel")}>
							<ErrorNotice
								error={draft.query.error}
								onRetry={() => void draft.query.refetch()}
								title={t`The draft could not be loaded`}
							/>
						</Box>
					) : draft.query.data ? (
						<SettingsSaveContext.Provider value={settingsEditor}>
							<SaveStatus
								formErrors={{}}
								savedAt={
									draft.query.data.saved_at
										? new Date(draft.query.data.saved_at)
										: null
								}
								isPendingSave={pendingFields.size > 0}
								isSaving={draft.save.isPending}
								isError={draft.save.isError}
							/>
							<Text size="sm">
								{watchedBy === "screen" ? (
									<Trans>
										The room screen is open, so changes wait until you show
										them.
									</Trans>
								) : watchedBy === "live" ? (
									<Trans>
										You’re live, so changes wait until you show them.
									</Trans>
								) : watchedBy === "public" ? (
									<Trans>
										The public page is on, so changes wait until you show them.
									</Trans>
								) : (
									<Trans>
										Changes show on the room screen as you make them.
									</Trans>
								)}
							</Text>
							<fieldset
								disabled={publishing}
								style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
							>
								<Stack gap="lg">
									<div className={classes.editor}>
										<DraftPreview
											block={previewBlock}
											projectId={projectId}
											presentation={draft.query.data.presentation}
											revision={draft.query.data.revision}
											notShown={waiting}
										/>
										<Editor
											projectId={projectId}
											presentation={draft.query.data.presentation}
										/>
									</div>
									{/* Outside the preview-and-editor row, so it spans the page. */}
									<PresentResultsPanel
										className={classes.results}
										onTabChange={setPreviewBlock}
										projectId={projectId}
										presentation={draft.query.data.presentation}
									/>
								</Stack>
							</fieldset>
						</SettingsSaveContext.Provider>
					) : (
						<Stack gap="md" role="status" aria-label={t`Loading draft`}>
							<Skeleton height={16} width={240} />
							<Skeleton height={360} />
						</Stack>
					)
				) : (
					<Preview presentation={presentation} />
				)}
				<Group justify="flex-start" gap="sm">
					<Text size="sm" c="dimmed">
						<Plural
							value={presentation.counts.phrases}
							one="# phrase"
							other="# phrases"
						/>
					</Text>
					<Group gap="xs">
						{canEdit && updates.data?.available && (
							<Button
								size="compact-sm"
								loading={adopt.isPending}
								onClick={() => adopt.mutate()}
							>
								<Trans>Use latest results</Trans>
							</Button>
						)}
						<Button
							size="compact-sm"
							variant="subtle"
							onClick={() =>
								navigate(
									`/w/${workspaceId}/projects/${projectId}/analysis?returnTo=present&section=${encodeURIComponent(editorSection(params))}`,
								)
							}
						>
							<Trans>Open in Analysis</Trans>
						</Button>
					</Group>
				</Group>
				<ErrorNotice
					error={adopt.error}
					onRetry={() => adopt.mutate()}
					title={t`Could not load the latest results`}
				/>
			</Stack>
		</PresentationEventTick.Provider>
	);
}

export function PresentRoute() {
	const { projectId = "" } = useParams();
	const query = usePresentation(projectId);
	const ensure = useEnsurePresentation(projectId);
	const initializing = useRef<string | null>(null);
	useEffect(() => {
		if (
			!query.data?.can_edit ||
			query.data.presentation ||
			initializing.current === projectId
		)
			return;
		initializing.current = projectId;
		ensure.mutate(false);
	}, [projectId, query.data, ensure.mutate]);
	const open = () => {
		if (!query.data?.presentation) return;
		window.open(
			`/present/screen/${encodeURIComponent(query.data.presentation.id)}`,
			"_blank",
			"noopener",
		);
	};
	if (query.isLoading) return <BeautifulLoading />;
	return (
		<PageContainer width="full" density="tight">
			<Stack gap="lg">
				<ErrorNotice
					error={ensure.error}
					title={t`The presentation could not be opened`}
				/>
				{query.isError ? (
					<Box {...testId("present-error-panel")}>
						<ErrorNotice
							error={query.error}
							onRetry={() => void query.refetch()}
							title={t`The presentation could not be loaded`}
						/>
					</Box>
				) : query.data?.presentation ? (
					<Session
						key={query.data.presentation.id}
						projectId={projectId}
						presentation={query.data.presentation}
						canEdit={query.data.can_edit}
						opening={ensure.isPending}
						open={open}
					/>
				) : (
					<Stack>
						<Title order={2}>
							<Trans>Present</Trans>
						</Title>
						{query.data?.can_edit === false ? (
							<Text size="sm" c="dimmed">
								<Trans>The host hasn’t prepared a presentation yet.</Trans>
							</Text>
						) : ensure.isError ? (
							<Group justify="flex-start">
								<Button onClick={() => ensure.mutate(false)}>
									<Trans>Try again</Trans>
								</Button>
							</Group>
						) : (
							<Stack
								gap="md"
								role="status"
								aria-label={t`Loading presentation`}
							>
								<Skeleton height={36} width={240} />
								<Skeleton height={360} />
							</Stack>
						)}
					</Stack>
				)}
			</Stack>
		</PageContainer>
	);
}
