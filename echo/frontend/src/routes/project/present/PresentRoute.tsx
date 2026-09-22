import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	Button,
	Checkbox,
	Group,
	Loader,
	Modal,
	Popover,
	Select,
	Stack,
	Switch,
	Tabs,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure, useElementSize } from "@mantine/hooks";
import {
	ArrowSquareOutIcon,
	BroadcastIcon,
	ListChecksIcon,
	MonitorIcon,
	PencilSimpleIcon,
	ShareNetworkIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useParams, useSearchParams } from "react-router";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { SaveStatus } from "@/components/form/SaveStatus";
import { PageContainer } from "@/components/layout/PageContainer";
import {
	type LiveHours,
	usePopcornLiveMutation,
	usePopcornSettingsMutation,
	usePopcornStopLiveMutation,
} from "@/components/popcorn/hooks";
import {
	PopcornAlsoLanguages,
	PopcornLanguageSettings,
} from "@/components/popcorn/PopcornLanguageSettings";
import { PopcornOpeningSettings } from "@/components/popcorn/PopcornOpeningSettings";
import { PopcornScreenSettings } from "@/components/popcorn/PopcornScreenSettings";
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
	orderedBlocks,
	PRESENTATION_BLOCKS,
} from "@/components/present/blocks";
import {
	type Presentation,
	presentationKey,
	useEnsurePresentation,
	usePresentation,
} from "@/components/present/hooks";
import {
	presentationDraftKey,
	useOpeningInlineEdit,
	usePresentationDraft,
} from "@/components/present/hooks/usePresentationDraft";
import { TranslationStatus } from "@/components/present/TranslationStatus";
import { API_BASE_URL } from "@/config";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useServerEvents } from "@/hooks/useServerEvents";
import { bff } from "@/lib/bff";
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
	return (
		<Stack className={classes.settings} gap="lg">
			<Group justify="space-between">
				<Text fw={500}>
					<Trans>Presentation editor</Trans>
				</Text>
			</Group>
			<PresentationTitle projectId={projectId} presentation={presentation} />
			<Tabs
				value={editorSection(params)}
				onChange={(value) =>
					setParams((old) => {
						const next = new URLSearchParams(old);
						next.set("section", value ?? "activities");
						return next;
					})
				}
			>
				<Tabs.List>
					<Tabs.Tab value="intro">
						<Trans>Intro</Trans>
					</Tabs.Tab>
					<Tabs.Tab value="data">
						<Trans>Data policy</Trans>
					</Tabs.Tab>
					<Tabs.Tab value="activities">
						<Trans>Tabs</Trans>
					</Tabs.Tab>
				</Tabs.List>
				<Tabs.Panel value="intro" pt="md">
					<PopcornOpeningSettings
						projectId={projectId}
						popcorn={presentation}
						section="intro"
					/>
				</Tabs.Panel>
				<Tabs.Panel value="data" pt="md">
					<PopcornOpeningSettings
						projectId={projectId}
						popcorn={presentation}
						section="data"
					/>
				</Tabs.Panel>
				<Tabs.Panel value="activities" pt="md">
					<Stack>
						<Text size="sm">
							<Trans>Choose the tabs your audience can explore.</Trans>
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
											presentation: {
												blocks: orderedBlocks(
													event.currentTarget.checked
														? [...selected, block]
														: selected.filter((item) => item !== block),
												),
											},
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
			</Tabs>
			<Accordion variant="default" multiple>
				<Accordion.Item value="language">
					<Accordion.Control>
						<Trans>Language</Trans>
					</Accordion.Control>
					<Accordion.Panel>
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
								presentation.settings.presentation?.language_policy ===
									"project"
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
					</Accordion.Panel>
				</Accordion.Item>
				<Accordion.Item value="screen">
					<Accordion.Control>
						<Trans>Screen appearance</Trans>
					</Accordion.Control>
					<Accordion.Panel>
						<PopcornScreenSettings
							embedded
							projectId={projectId}
							popcorn={presentation}
							showToolToggles={false}
						/>
					</Accordion.Panel>
				</Accordion.Item>
			</Accordion>
		</Stack>
	);
}

// `?section=results` was a tab of the editor once. It now opens the results
// panel, and the editor falls back to its own first stop.
const RESULTS_SECTION = "results";
function editorSection(params: URLSearchParams) {
	const section = params.get("section");
	return !section || section === RESULTS_SECTION ? "activities" : section;
}

// The draft on the room's screen. Typing into its opening saves like any other
// field of the draft.
function DraftPreview({
	projectId,
	presentation,
	revision,
}: {
	projectId: string;
	presentation: Presentation;
	revision: number;
}) {
	const save = usePopcornSettingsMutation(projectId, presentation.id);
	return (
		<Preview
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
}: {
	presentation: Presentation;
	draft?: boolean;
	revision?: number;
	onEditOpening?: AudienceScreenProps["onEditOpening"];
}) {
	const eventTick = useContext(PresentationEventTick);
	// The room's screen at its own size, shrunk to fit the column. At the
	// column's width the real screen would run its title into its tabs and clip
	// them; scaled, the host sees what the room will see.
	const { ref, width } = useElementSize();
	return (
		<div className={classes.preview}>
			<Group px="md" py="sm" gap="xs">
				<MonitorIcon size={18} />
				<Text size="sm" fw={500}>
					<Trans>Audience preview</Trans>
				</Text>
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
	const [params, setParams] = useSearchParams();
	const navigate = useI18nNavigate();
	const { workspaceId, presentationId } = useParams();
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
	const blocks = orderedBlocks(
		presentation.settings.presentation?.blocks ?? ["popcorn"],
	);
	const live = usePopcornLiveMutation(projectId, presentation.id);
	const stop = usePopcornStopLiveMutation(projectId, presentation.id);
	const [hours, setHours] = useState<LiveHours>(8);
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
	const editing = canEdit && (params.get("edit") === "1" || !!presentationId);
	// The results panel has its own state, so a host can review what the room
	// will read without opening the presentation editor.
	const reviewing =
		canEdit &&
		(params.get("results") === "1" ||
			params.get("section") === RESULTS_SECTION);
	const setReviewing = (on: boolean) =>
		setParams((old) => {
			const next = new URLSearchParams(old);
			if (on) next.set("results", "1");
			else {
				next.delete("results");
				next.delete("resultsPage");
				if (next.get("section") === RESULTS_SECTION) next.delete("section");
			}
			return next;
		});
	// Both panels work on the draft, so either one puts the draft on the preview
	// and Publish within reach.
	const drafting = editing || reviewing;
	const [sharing, share] = useDisclosure(false);
	const [liveOptions, liveDisclosure] = useDisclosure(false);
	const draft = usePresentationDraft(
		projectId,
		presentation.id,
		// A host who may edit also types into the opening on the preview below.
		canEdit,
	);
	const editOpeningLive = useOpeningInlineEdit(draft, true);
	const flushers = useRef(new Set<() => Promise<void>>());
	const [pendingFields, setPendingFields] = useState(new Set<string>());
	const [publishing, setPublishing] = useState(false);
	const [publishError, setPublishError] = useState(false);
	const registerFlush = useCallback((flush: () => Promise<void>) => {
		flushers.current.add(flush);
		return () => {
			flushers.current.delete(flush);
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
	const publishChanges = async () => {
		setPublishing(true);
		setPublishError(false);
		try {
			for (const flush of flushers.current) await flush();
			await draft.publish.mutateAsync();
		} catch {
			setPublishError(true);
		} finally {
			setPublishing(false);
		}
	};
	const closeEditor = async () => {
		try {
			for (const flush of flushers.current) await flush();
			if (presentationId)
				navigate(`/w/${workspaceId}/projects/${projectId}/present`);
			else
				setParams((old) => {
					const next = new URLSearchParams(old);
					next.set("edit", "0");
					return next;
				});
		} catch {
			setPublishError(true);
		}
	};
	return (
		<PresentationEventTick.Provider value={eventTick}>
			<Stack gap="md">
				<Group justify="space-between" align="center">
					<Stack gap={4}>
						<Title order={2}>
							<Trans>Present</Trans>
						</Title>
						<Text size="sm">{presentation.name}</Text>
					</Stack>
					<Group
						gap="xs"
						className={classes.hostActions}
						aria-label={t`Presentation controls`}
					>
						{canEdit &&
							(blocks.includes("popcorn") ||
								presentation.loop?.mode === "live") &&
							(presentation.loop?.mode === "live" ? (
								<Button
									variant="outline"
									leftSection={<BroadcastIcon size={18} weight="fill" />}
									loading={stop.isPending}
									onClick={() => stop.mutate()}
								>
									<Trans>Stop live</Trans>
								</Button>
							) : (
								<Popover
									opened={liveOptions}
									onChange={(opened) =>
										opened ? liveDisclosure.open() : liveDisclosure.close()
									}
									position="bottom-end"
									width={320}
									withArrow
								>
									<Popover.Target>
										<Button
											variant="outline"
											leftSection={<BroadcastIcon size={18} />}
											onClick={liveDisclosure.toggle}
										>
											<Trans>Go live</Trans>
										</Button>
									</Popover.Target>
									<Popover.Dropdown>
										<Stack gap="md">
											<Text size="sm">
												<Trans>
													Keep Popcorn up to date as conversations arrive. You
													can go live before the first recording.
												</Trans>
											</Text>
											<Select
												label={t`Duration`}
												value={String(hours)}
												allowDeselect={false}
												data={[
													{ label: t`1 hour`, value: "1" },
													{ label: t`8 hours`, value: "8" },
													{ label: t`24 hours`, value: "24" },
												]}
												onChange={(value) =>
													value && setHours(Number(value) as LiveHours)
												}
											/>
											<Button
												leftSection={<BroadcastIcon size={18} />}
												loading={live.isPending}
												onClick={() =>
													live.mutate(hours, {
														onSuccess: liveDisclosure.close,
													})
												}
											>
												<Trans>Go live</Trans>
											</Button>
										</Stack>
									</Popover.Dropdown>
								</Popover>
							))}
						{canEdit && (
							<Button
								variant="outline"
								leftSection={<ShareNetworkIcon size={18} />}
								onClick={share.open}
							>
								<Trans>Share</Trans>
							</Button>
						)}
						<Button
							onClick={open}
							loading={opening}
							leftSection={<ArrowSquareOutIcon size={18} />}
						>
							<Trans>Present</Trans>
						</Button>
					</Group>
				</Group>
				{presentation.loop?.mode === "live" && (
					<Text size="sm" role="status">
						<Trans>
							Live. New conversations will feed Popcorn as they arrive.
						</Trans>
					</Text>
				)}
				{canEdit && (
					<Group justify="space-between">
						<Group gap="xs">
							<Button
								variant="subtle"
								disabled={publishing}
								leftSection={<PencilSimpleIcon size={18} />}
								onClick={() => {
									if (editing) {
										void closeEditor();
										return;
									}
									setParams((old) => {
										const next = new URLSearchParams(old);
										next.set("edit", "1");
										return next;
									});
								}}
							>
								{editing ? t`Done editing` : t`Edit presentation`}
							</Button>
							<Button
								variant="subtle"
								disabled={publishing}
								aria-pressed={reviewing}
								leftSection={<ListChecksIcon size={18} />}
								onClick={() => setReviewing(!reviewing)}
							>
								{reviewing ? t`Done reviewing` : t`Review results`}
							</Button>
						</Group>
						{drafting && (
							<Button
								onClick={() => void publishChanges()}
								loading={publishing}
								disabled={
									!draft.query.data ||
									draft.save.isPending ||
									draft.save.isError ||
									(!draft.query.data.has_changes && !pendingFields.size)
								}
							>
								<Trans>Publish changes</Trans>
							</Button>
						)}
					</Group>
				)}
				<Modal
					opened={sharing}
					onClose={share.close}
					title={t`Share presentation`}
					size="lg"
				>
					{draft.query.data ? (
						<SettingsSaveContext.Provider value={settingsEditor}>
							<Stack gap="lg">
								<fieldset
									disabled={publishing}
									style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
								>
									<PopcornShare
										embedded
										projectId={projectId}
										popcorn={draft.query.data.presentation}
										presentation
									/>
								</fieldset>
								<SaveStatus
									formErrors={{}}
									savedAt={
										draft.query.data.saved_at
											? new Date(draft.query.data.saved_at)
											: null
									}
									isPendingSave={false}
									isSaving={draft.save.isPending}
									isError={draft.save.isError}
								/>
								<Text size="sm">
									<Trans>
										The shared screen shows your published presentation. Publish
										changes to update its content and access.
									</Trans>
								</Text>
								{publishError && (
									<Text role="alert">
										<Trans>Changes could not be published. Try again.</Trans>
									</Text>
								)}
								<Group justify="flex-end">
									<Button
										loading={publishing}
										disabled={
											!draft.query.data.has_changes ||
											draft.save.isPending ||
											draft.save.isError
										}
										onClick={() => void publishChanges()}
									>
										<Trans>Publish changes</Trans>
									</Button>
								</Group>
							</Stack>
						</SettingsSaveContext.Provider>
					) : draft.query.isError ? (
						<Text role="alert">
							<Trans>The draft could not be loaded.</Trans>
						</Text>
					) : (
						<Loader aria-label={t`Loading presentation`} />
					)}
				</Modal>
				{drafting ? (
					draft.query.isError ? (
						<FetchErrorPanel
							message={<Trans>The draft could not be loaded.</Trans>}
							onRetry={() => void draft.query.refetch()}
							testId="present-draft-error-panel"
						/>
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
								<Trans>
									Changes are saved as a draft. Publish when you’re ready to
									update the room screen.
								</Trans>
							</Text>
							<fieldset
								disabled={publishing}
								style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
							>
								<Stack gap="lg">
									<div className={editing ? classes.editor : undefined}>
										<DraftPreview
											projectId={projectId}
											presentation={draft.query.data.presentation}
											revision={draft.query.data.revision}
										/>
										{editing && (
											<Editor
												projectId={projectId}
												presentation={draft.query.data.presentation}
											/>
										)}
									</div>
									{/* Outside the preview-and-editor row, so it spans the page. */}
									{reviewing && (
										<PresentResultsPanel
											className={classes.results}
											projectId={projectId}
											presentation={draft.query.data.presentation}
											onClose={() => setReviewing(false)}
										/>
									)}
								</Stack>
							</fieldset>
						</SettingsSaveContext.Provider>
					) : (
						<Text>
							<Trans>Loading draft…</Trans>
						</Text>
					)
				) : (
					<Preview
						presentation={presentation}
						onEditOpening={editOpeningLive}
					/>
				)}
				{publishError && (
					<Text role="alert" size="sm">
						<Trans>
							Changes could not be published or saved. Review your draft and try
							again.
						</Trans>
					</Text>
				)}
				<Group justify="space-between" gap="sm">
					<Text size="sm">
						{presentation.counts.phrases} <Trans>phrases</Trans>
					</Text>
					<Group gap="xs">
						{canEdit && updates.data?.available && (
							<Button
								size="compact-sm"
								variant="outline"
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
									`/w/${workspaceId}/projects/${projectId}/analysis?returnTo=present&section=${encodeURIComponent(reviewing && !editing ? RESULTS_SECTION : editorSection(params))}`,
								)
							}
						>
							<Trans>Open in Analysis</Trans>
						</Button>
					</Group>
				</Group>
				{adopt.isError && (
					<Text role="alert" size="sm">
						<Trans>Could not load the latest results. Try again.</Trans>
					</Text>
				)}
			</Stack>
		</PresentationEventTick.Provider>
	);
}

export function PresentRoute() {
	const { projectId = "" } = useParams();
	const query = usePresentation(projectId);
	const ensure = useEnsurePresentation(projectId);
	const [, setParams] = useSearchParams();
	const initializing = useRef<string | null>(null);
	useEffect(() => {
		if (
			!query.data?.can_edit ||
			query.data.presentation ||
			initializing.current === projectId
		)
			return;
		initializing.current = projectId;
		ensure.mutate(false, {
			onSuccess: () =>
				setParams(
					(old) => {
						const next = new URLSearchParams(old);
						next.set("edit", "1");
						return next;
					},
					{ replace: true },
				),
		});
	}, [projectId, query.data, ensure.mutate, setParams]);
	const open = () => {
		if (!query.data?.presentation) return;
		window.open(
			`/present/screen/${encodeURIComponent(query.data.presentation.id)}`,
			"_blank",
			"noopener",
		);
	};
	if (query.isLoading) return <Loader aria-label={t`Loading presentation`} />;
	return (
		<PageContainer width="full" density="tight">
			<Stack gap="lg">
				{ensure.isError && (
					<Text role="alert">
						<Trans>The presentation could not be opened. Try again.</Trans>
					</Text>
				)}
				{query.isError ? (
					<FetchErrorPanel
						message={<Trans>The presentation could not be loaded.</Trans>}
						onRetry={() => void query.refetch()}
						testId="present-error-panel"
					/>
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
							<Text>
								<Trans>The host hasn’t prepared a presentation yet.</Trans>
							</Text>
						) : ensure.isError ? (
							<Button variant="outline" onClick={() => ensure.mutate(false)}>
								<Trans>Try again</Trans>
							</Button>
						) : (
							<Loader aria-label={t`Loading presentation`} />
						)}
					</Stack>
				)}
			</Stack>
		</PageContainer>
	);
}
