import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Collapse,
	Container,
	Group,
	Paper,
	Radio,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import type { DigestFallback } from "@/components/project/digest/DigestConnected";
import {
	LazyDigest,
	LazyNameStepDigest,
} from "@/components/project/digest/lazy";
import type { DigestCreateBody } from "@/components/project/digest/review";
import { useUpdateProjectByIdMutation } from "@/components/project/hooks";
import { KeyTermsInput } from "@/components/project/KeyTermsInput";
import { ProjectContextInput } from "@/components/project/ProjectContextInput";
import { projectLanguageForLocale } from "@/components/project/projectLanguage";
import { LazySessionBrief } from "@/components/project/setup-suggestions/lazy";
import type { SettingOverrides } from "@/components/project/setup-suggestions/SessionBrief/SessionBriefConnected";
import {
	hasTerm,
	type SetupSuggestions,
} from "@/components/project/setup-suggestions/setupSuggestions";
import { FlowProgress } from "@/components/project/templates/FlowProgress/FlowProgress";
import { useTemplatesCatalog } from "@/components/project/templates/i18n";
import {
	LazyAllFormats,
	LazyTemplateRow,
} from "@/components/project/templates/lazy";
import {
	isTemplateKey,
	type TemplateKey,
	templateName,
	useProjectTemplates,
} from "@/components/project/templates/projectTemplates";
import type { TemplateChoiceContext } from "@/components/project/templates/TemplatePicker/TemplatePicker";
import { TemplateSetupSummary } from "@/components/project/templates/TemplateSetupSummary/TemplateSetupSummary";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { AGENTIC_CHAT_IS_DEFAULT, ENABLE_AGENTIC_CHAT } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { useProjectCapStatus } from "@/hooks/useProjectCap";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useCreateWorkspaceProject } from "@/hooks/useWorkspaceProjects";
import {
	keyTermCount,
	type ProjectCreateStep,
	track,
} from "@/lib/analytics/events";
import { apiJson } from "@/lib/apiJson";
import { isFreeTierLimitError } from "@/lib/freeTier";
import { openConfirm } from "@/lib/openConfirm";
import { isAdminRole, isOutsiderRole } from "@/lib/roles";

type Access = "workspace" | "private";

const SETUP_INITIAL_MESSAGE = "Help me set up this project.";

// The screens (flow 4, ECHO-1058): start (the upload and the row of formats), all formats
// when the host skips both, then the name. Analytics names them "template", "formats" and
// "name"; "More options" is not a screen: opening it is counted as "more_options".
type Screen = "start" | "formats" | "name";
const CREATE_STEPS: Record<Screen, ProjectCreateStep> = {
	formats: "formats",
	name: "name",
	start: "template",
};

const setVisibility = (projectId: string, visibility: Access) =>
	apiJson(`/v2/projects/${projectId}/visibility`, {
		body: { visibility },
		method: "PATCH",
	});

/**
 * Creating a project, one thing at a time (ECHO-1058). The template's preset is applied by
 * the server in the creating transaction.
 *
 * Start: the offer to set up from what the host already has (the context digest,
 * ECHO-1055: drop an agenda, invitation or run sheet, paste text or add a link). dembrane
 * reads it and proposes the setup, reviewed one part per screen; Create there makes the
 * project with what they kept. If the digest fails, the row takes over with the material's
 * text in the project context. Under it, every format in one row of drawn cards: pressing
 * one chooses it and goes to the name. "See all formats" leads to the full list with its
 * filters (verbs and setup), and the quiet "Upload recordings" and "Start blank". A
 * ?template=<key> link (workspace home's picker) arrives on the name with it chosen.
 *
 * Step 2 "Name": name and the optional project context, with "Suggest key terms" under it
 * (setup suggestions from the context: key terms and settings to accept), and "What this
 * sets up", collapsed, then Create. Key terms, access,
 * the assistant switch and the review sit behind "More options", with the defaults they
 * always had: no key terms, open to the workspace, assistant off.
 *
 * After creating: project home, the upload page for a template that lands there, or the
 * assistant chat when its switch is on.
 */
export const CreateProjectRoute = () => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const { workspace, workspaceId } = useWorkspace();
	const { language } = useLanguage();
	const [searchParams] = useSearchParams();
	const linked = searchParams.get("template");
	const linkedTemplate = isTemplateKey(linked) ? linked : null;

	const [screen, setScreen] = useState<Screen>(
		linkedTemplate ? "name" : "start",
	);
	// Where Back on the name goes: the screen the card was pressed on.
	const [chosenOn, setChosenOn] = useState<Screen>("start");
	const [template, setTemplate] = useState<TemplateKey | null>(linkedTemplate);
	const [name, setName] = useState("");
	const [context, setContext] = useState("");
	const [keyTerms, setKeyTerms] = useState("");
	// Settings accepted from the setup suggestions, sent as overrides on the template.
	const [overrides, setOverrides] = useState<SettingOverrides>({});
	const suggestedRef = useRef<SetupSuggestions | null>(null);
	const [access, setAccess] = useState<Access>("workspace");
	// The digest's reading states and review replace the picker while they show.
	const [digestActive, setDigestActive] = useState(false);
	const [moreOpened, moreHandlers] = useDisclosure(false);
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);
	// Availability is not default-ness. The assistant setup starts an agentic
	// chat, so it follows AGENTIC_CHAT_IS_DEFAULT: off unless the host ticks it.
	// Pre-ticking it would fire an agentic run on every project created,
	// before the host has typed anything.
	const [setupWithAssistant, setSetupWithAssistant] = useState(
		AGENTIC_CHAT_IS_DEFAULT,
	);
	const projectLanguage = projectLanguageForLocale(language);
	const templates = useProjectTemplates(projectLanguage);
	const chosen = templates.data?.find((tpl) => tpl.key === template);
	const landing = chosen?.landing ?? "home";
	// The picker's words are in their own catalog, loaded when this page opens.
	const catalogReady = useTemplatesCatalog();
	// What the picker knew when the card was chosen; sent when the host continues.
	const choiceRef = useRef<TemplateChoiceContext | null>(null);

	useDocumentTitle(t`Create project | dembrane`);

	// Funnel: each step shown, and the step a host left on without creating.
	const createStep = CREATE_STEPS[screen];
	const lastStepRef = useRef<ProjectCreateStep>(createStep);
	const createdRef = useRef(false);
	useEffect(() => {
		lastStepRef.current = createStep;
		track("project_create_step_viewed", { step: createStep });
	}, [createStep]);
	// Leaving counts once: by navigating away (unmount) or by closing the tab.
	useEffect(() => {
		let left = false;
		const leave = () => {
			if (left || createdRef.current) return;
			left = true;
			track("project_create_abandoned", { step: lastStepRef.current });
		};
		window.addEventListener("pagehide", leave);
		return () => {
			window.removeEventListener("pagehide", leave);
			leave();
		};
	}, []);

	const tier = workspace?.tier ?? "pilot";
	// Deep-link fallback, decided once per visit; the create buttons open the wall in place.
	const cap = useProjectCapStatus(workspace);
	const capDecided = useRef(false);
	const wizardStarted =
		screen !== "start" || template !== null || name.trim() !== "";
	const [atProjectCap, setAtProjectCap] = useState(false);
	// Opened after mount: the configurator mounted already open closes itself under StrictMode.
	useEffect(() => {
		if (capDecided.current || !cap.settled) return;
		capDecided.current = true;
		if (cap.atCap && !wizardStarted) {
			setAtProjectCap(true);
			upgradeHandlers.open();
		}
	}, [cap.atCap, cap.settled, wizardStarted, upgradeHandlers.open]);
	const privateTiers = new Set(["innovator", "changemaker", "guardian"]);
	const privateAvailable = privateTiers.has(tier);

	const createProject = useCreateWorkspaceProject();
	const updateProject = useUpdateProjectByIdMutation();

	// Settings accepted for one template are not carried to another.
	const pickTemplate = (key: TemplateKey, context?: TemplateChoiceContext) => {
		if (key !== template) setOverrides({});
		setTemplate(key);
		choiceRef.current = context ?? null;
	};

	const chooseTemplate = (
		key: TemplateKey,
		context?: TemplateChoiceContext,
	) => {
		pickTemplate(key, context ?? choiceRef.current ?? undefined);
		const tpl = templates.data?.find((x) => x.key === key);
		const ctx = context ?? choiceRef.current;
		track("project_template_selected", {
			featured: ctx?.featured ?? tpl?.card.featured ?? false,
			filters_active: ctx?.filtersActive ?? [],
			...(ctx?.list && { list: ctx.list }),
			setup: ctx?.setup ?? tpl?.card.setup ?? null,
			surface: "create",
			template_key: key,
			verbs: ctx?.verbs ?? tpl?.card.verbs ?? [],
		});
		setChosenOn(screen === "formats" ? "formats" : "start");
		setScreen("name");
	};

	const openMore = () => {
		if (!moreOpened) {
			lastStepRef.current = "more_options";
			track("project_create_step_viewed", { step: "more_options" });
		}
		moreHandlers.toggle();
	};

	const submit = useMutation({
		mutationFn: async () => {
			const project = await createProject.mutateAsync({
				language: projectLanguage,
				name: name.trim(),
				templateKey: template ?? "blank",
				...(Object.keys(overrides).length > 0 && { overrides }),
			});

			// Only what the host typed: the template wrote every other setting.
			const typed = {
				...(context.trim() && { context: context.trim() }),
				...(keyTerms && { default_conversation_transcript_prompt: keyTerms }),
			};
			if (Object.keys(typed).length) {
				await updateProject.mutateAsync({ id: project.id, payload: typed });
			}

			if (access === "private" && privateAvailable) {
				await setVisibility(project.id, "private");
			}

			return project;
		},
		onError: (error: Error) => {
			if (isFreeTierLimitError(error) === "projects") {
				upgradeHandlers.open();
				return;
			}
			void notifyError(error);
		},
		onSuccess: (project) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-projects"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			createdRef.current = true;
			track("project_created", {
				project_id: project.id,
				started_from: "picker",
				template_key: template ?? "blank",
			});
			const suggested = suggestedRef.current;
			if (suggested) {
				track("project_setup_ai_accepted", {
					settings_accepted: Object.keys(overrides).length,
					surface: "wizard",
					terms_accepted: suggested.key_terms.filter((s) =>
						hasTerm(keyTerms, s.term),
					).length,
				});
			}
			const terms = keyTermCount(keyTerms);
			if (terms > 0) {
				track("key_terms_updated", {
					count: terms,
					project_id: project.id,
					surface: "wizard",
				});
			}
			toast.success(t`Project created`);
			const base = `/w/${workspaceId}/projects/${project.id}`;
			if (ENABLE_AGENTIC_CHAT && setupWithAssistant) {
				// Ticking the toggle is the opt-in, so name the mode explicitly
				// rather than letting the Ask screen assume agentic.
				navigate(`${base}/chats/new`, {
					state: {
						initialMessage: SETUP_INITIAL_MESSAGE,
						preferMode: "agentic",
					},
				});
			} else if (landing === "upload") {
				navigate(`${base}/upload`);
			} else {
				navigate(`${base}/home`);
			}
		},
	});

	// Create from the digest's review: the template and everything the host kept, in one
	// request and one transaction. Resolves false when the project was not created.
	const createFromDigest = useMutation({
		mutationFn: async (body: DigestCreateBody) => {
			const project = await createProject.mutateAsync({
				digest: body.digest,
				language: projectLanguage,
				name: body.name,
				templateKey: body.templateKey,
			});
			return { body, project };
		},
		onError: (error: Error) => {
			if (isFreeTierLimitError(error) === "projects") {
				upgradeHandlers.open();
				return;
			}
			void notifyError(error);
		},
		onSuccess: ({ body, project }) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-projects"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			createdRef.current = true;
			track("project_created", {
				project_id: project.id,
				started_from: "digest",
				template_key: body.templateKey,
			});
			const terms = body.digest.key_terms?.length ?? 0;
			if (terms > 0)
				track("key_terms_updated", {
					count: terms,
					project_id: project.id,
					surface: "wizard",
				});
			toast.success(t`Project created`);
			const lands = templates.data?.find((x) => x.key === body.templateKey);
			const base = `/w/${workspaceId}/projects/${project.id}`;
			navigate(lands?.landing === "upload" ? `${base}/upload` : `${base}/home`);
		},
	});

	const onDigestFallback = (fallback: DigestFallback) => {
		if (!fallback.context) return;
		setContext((prev) =>
			prev.trim() ? `${prev.trim()}\n\n${fallback.context}` : fallback.context,
		);
	};

	const backToProjects = () => {
		if (workspaceId) {
			navigate(`/w/${workspaceId}/home`);
		} else {
			navigate("/o");
		}
	};

	const handleCancel = () => {
		if (name.trim() || context.trim() || keyTerms) {
			openConfirm({
				children: (
					<Text size="sm">
						<Trans>Your draft won't be saved.</Trans>
					</Text>
				),
				danger: true,
				labels: { cancel: t`Keep editing`, confirm: t`Discard` },
				onConfirm: backToProjects,
				title: t`Discard this project?`,
			});
		} else {
			backToProjects();
		}
	};

	if (!workspace || !catalogReady) {
		return <BeautifulLoading />;
	}

	// Outsiders lack project:create; a deep link lands here instead of a 403 on Create.
	if (isOutsiderRole(workspace.role)) {
		return (
			<Container size="sm" py="xl" px="lg">
				<Stack
					align="center"
					mt="20vh"
					gap="md"
					data-testid="create-project-not-allowed"
				>
					<Title order={4} ta="center">
						<Trans>You can't create projects in this workspace.</Trans>
					</Title>
					<Text size="sm" c="dimmed" ta="center" maw={420}>
						<Trans>Ask a workspace admin to create the project for you.</Trans>
					</Text>
					<Button variant="subtle" size="xs" onClick={backToProjects}>
						<Trans>Back to projects</Trans>
					</Button>
				</Stack>
			</Container>
		);
	}

	const canCreate = name.trim().length > 0;
	const templateLabel = templateName(template ?? "blank");

	return (
		<Container size="md" py="xl" px="lg">
			<Stack gap="xl">
				{/* The review after an upload shows its own progress, one part per screen. */}
				{!digestActive && (
					<FlowProgress
						step={screen === "name" ? 2 : 1}
						total={2}
						testId="create-project-progress"
					/>
				)}
				{!digestActive && (
					<Stack gap="xs">
						<Title order={2}>
							<Trans>Create project</Trans>
						</Title>
						<Text size="sm" c="dimmed">
							<Trans>
								Creating in <em>{workspace.name}</em>
							</Trans>
						</Text>
					</Stack>
				)}

				{screen === "start" && (
					<Stack gap="xl" data-testid="create-project-start">
						<LazyDigest
							workspaceId={workspaceId ?? null}
							language={projectLanguage}
							templates={templates.data}
							onActiveChange={setDigestActive}
							onFallback={onDigestFallback}
							onCreate={async (body) => {
								try {
									await createFromDigest.mutateAsync(body);
									return true;
								} catch {
									return false;
								}
							}}
							creating={createFromDigest.isPending}
							pageDrop
						/>
						{!digestActive && (
							<>
								<LazyTemplateRow
									templates={templates.data}
									failed={templates.isError}
									onChoose={chooseTemplate}
									onSeeAll={() => setScreen("formats")}
								/>
								<Group gap="sm">
									<Button
										variant="subtle"
										color="gray"
										size="sm"
										onClick={handleCancel}
									>
										<Trans>Cancel</Trans>
									</Button>
								</Group>
							</>
						)}
					</Stack>
				)}

				{screen === "formats" && (
					<Stack gap="lg">
						<LazyAllFormats
							templates={templates.data}
							failed={templates.isError}
							onChoose={chooseTemplate}
							onFilterChange={(filter, value) =>
								track("project_template_filter_changed", {
									filter,
									value,
								})
							}
							onUpload={() => chooseTemplate("upload")}
							onStartBlank={() => chooseTemplate("blank")}
						/>
						<Group gap="sm">
							<Button
								variant="subtle"
								color="gray"
								size="sm"
								onClick={() => setScreen("start")}
								data-testid="create-project-formats-back"
							>
								<Trans>Back</Trans>
							</Button>
						</Group>
					</Stack>
				)}

				{screen === "name" && (
					<Stack gap="md">
						<Text size="sm" data-testid="create-project-chosen-template">
							<Trans>Starting from: {templateLabel}</Trans>
						</Text>
						<TextInput
							autoFocus
							label={t`Project name`}
							description={t`Name it after the topic, engagement, or question you're exploring.`}
							placeholder={t`e.g. Climate Listening, Q1 Research`}
							value={name}
							onChange={(e) => setName(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && canCreate && !submit.isPending) {
									e.preventDefault();
									submit.mutate();
								}
							}}
						/>

						{/* One field: the context is saved with the project and is what
							    "Suggest key terms" reads. Optional and never in the way: Create
							    stays enabled while it runs, and accepted terms land in the key
							    terms under "More options". */}
						<Stack gap="xs">
							<ProjectContextInput
								value={context}
								onChange={(e) => setContext(e.currentTarget.value)}
							/>
							<LazySessionBrief
								workspaceId={workspaceId ?? null}
								templateKey={template ?? "blank"}
								name={name}
								description={context}
								language={projectLanguage}
								keyTerms={keyTerms}
								onKeyTermsChange={setKeyTerms}
								overrides={overrides}
								onOverridesChange={setOverrides}
								onResult={(result) => {
									suggestedRef.current = result;
								}}
							/>
							<LazyNameStepDigest
								workspaceId={workspaceId ?? null}
								language={projectLanguage}
								name={name}
								context={context}
								keyTerms={keyTerms}
								onContextChange={setContext}
								onKeyTermsChange={setKeyTerms}
							/>
						</Stack>

						{chosen && template !== "blank" && (
							<TemplateSetupSummary key={chosen.key} template={chosen} />
						)}

						<Stack gap="xs">
							<Button
								variant="subtle"
								size="sm"
								w="fit-content"
								leftSection={
									moreOpened ? (
										<CaretDownIcon size={16} />
									) : (
										<CaretRightIcon size={16} />
									)
								}
								aria-expanded={moreOpened}
								aria-controls="create-project-more-options"
								onClick={openMore}
								data-testid="create-project-more-options-toggle"
							>
								<Trans>More options</Trans>
							</Button>
							<Collapse in={moreOpened}>
								<Stack
									gap="lg"
									id="create-project-more-options"
									data-testid="create-project-more-options"
								>
									<Stack gap="xs">
										<Text size="md" component="h3" m={0}>
											<Trans>Key terms</Trans>
										</Text>
										<KeyTermsInput
											value={keyTerms}
											onChange={setKeyTerms}
											inputTestId="create-project-key-terms-input"
										/>
									</Stack>

									<Radio.Group
										label={t`Who can see this project?`}
										description={t`You can change this later in project settings.`}
										value={access}
										onChange={(v) => setAccess(v as Access)}
									>
										<Stack gap="sm" mt="sm">
											<Radio
												value="workspace"
												label={
													<Stack gap="xs">
														<Text size="sm">
															<Trans>Open to the workspace</Trans>
														</Text>
														<Text size="xs" c="dimmed">
															<Trans>
																Everyone in {workspace.name} can find and open
																this project.
															</Trans>
														</Text>
													</Stack>
												}
											/>
											<Radio
												value="private"
												disabled={!privateAvailable}
												label={
													<Stack gap="xs">
														<Text
															size="sm"
															c={privateAvailable ? undefined : "dimmed"}
														>
															<Trans>Private</Trans>
															{!privateAvailable && (
																<Text span size="xs" c="dimmed">
																	{" "}
																	(<Trans>Innovator or higher</Trans>)
																</Text>
															)}
														</Text>
														<Text size="xs" c="dimmed">
															<Trans>
																Only workspace admins and the people you invite
																can open this project.
															</Trans>
														</Text>
													</Stack>
												}
											/>
										</Stack>
									</Radio.Group>

									{ENABLE_AGENTIC_CHAT ? (
										<Switch
											checked={setupWithAssistant}
											onChange={(event) =>
												setSetupWithAssistant(event.currentTarget.checked)
											}
											label={t`Set up with the assistant after creating`}
											description={t`You'll land in a chat where dembrane helps shape the project before you collect conversations.`}
										/>
									) : null}

									<Paper withBorder p="md">
										<Stack gap="sm" data-testid="create-project-review">
											<ReviewRow label={t`Template`}>{templateLabel}</ReviewRow>
											<ReviewRow label={t`Name`}>
												{name.trim() || t`(missing)`}
											</ReviewRow>
											<ReviewRow
												label={t`Project context`}
												muted={!context.trim()}
											>
												{context.trim() || t`(none)`}
											</ReviewRow>
											<ReviewRow label={t`Key terms`} muted={!keyTerms}>
												{keyTerms || t`(none)`}
											</ReviewRow>
											<ReviewRow label={t`Workspace`}>
												{workspace.name}
											</ReviewRow>
											<ReviewRow label={t`Access`}>
												{access === "workspace" ? (
													<Trans>Open to the workspace</Trans>
												) : (
													<Trans>Private</Trans>
												)}
											</ReviewRow>
											{ENABLE_AGENTIC_CHAT ? (
												<ReviewRow label={t`Setup`}>
													{setupWithAssistant ? (
														<Trans>Start in assistant chat</Trans>
													) : landing === "upload" ? (
														<Trans>Go to the upload page</Trans>
													) : (
														<Trans>Go to project home</Trans>
													)}
												</ReviewRow>
											) : null}
											<ReviewRow label={t`Tier`}>
												<span style={{ textTransform: "capitalize" }}>
													{tier}
												</span>
											</ReviewRow>
										</Stack>
									</Paper>
								</Stack>
							</Collapse>
						</Stack>

						<Group gap="sm" mt="sm">
							<Button
								variant="filled"
								size="sm"
								loading={submit.isPending}
								disabled={!canCreate}
								onClick={() => submit.mutate()}
								data-testid="create-project-submit"
							>
								<Trans>Create project</Trans>
							</Button>
							<Button
								variant="subtle"
								color="gray"
								size="sm"
								onClick={() => setScreen(chosenOn)}
								data-testid="create-project-name-back"
							>
								<Trans>Back</Trans>
							</Button>
						</Group>
					</Stack>
				)}
			</Stack>
			<UpgradeModal
				opened={upgradeOpened}
				onClose={atProjectCap ? backToProjects : upgradeHandlers.close}
				// The 402 proves the account is free, whatever this workspace shows.
				currentTier="free"
				requiredTier="changemaker"
				canRequestUpgrade={isAdminRole(workspace?.role)}
				workspaceId={workspace?.id ?? ""}
				wallKey="project_cap"
			/>
		</Container>
	);
};

const ReviewRow = ({
	label,
	muted = false,
	children,
}: {
	label: string;
	muted?: boolean;
	children: ReactNode;
}) => (
	<Group gap="md" align="flex-start" wrap="nowrap">
		<Text size="xs" c="dimmed" w={100} style={{ flexShrink: 0 }}>
			{label}
		</Text>
		<Text
			size="sm"
			c={muted ? "dimmed" : undefined}
			style={{ flex: 1, whiteSpace: "pre-wrap" }}
		>
			{children}
		</Text>
	</Group>
);
