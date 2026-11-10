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
	Stepper,
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
import { useUpdateProjectByIdMutation } from "@/components/project/hooks";
import { KeyTermsInput } from "@/components/project/KeyTermsInput";
import { ProjectContextInput } from "@/components/project/ProjectContextInput";
import { projectLanguageForLocale } from "@/components/project/projectLanguage";
import {
	isTemplateKey,
	type TemplateKey,
	templateName,
	useProjectTemplates,
} from "@/components/project/templates/projectTemplates";
import { TemplatePickerConnected } from "@/components/project/templates/TemplatePicker/TemplatePickerConnected";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import {
	AGENTIC_CHAT_IS_DEFAULT,
	API_BASE_URL,
	ENABLE_AGENTIC_CHAT,
} from "@/config";
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
import { ApiRequestError } from "@/lib/errors/read";
import { isFreeTierLimitError } from "@/lib/freeTier";
import { openConfirm } from "@/lib/openConfirm";
import { isAdminRole, isOutsiderRole } from "@/lib/roles";

type Access = "workspace" | "private";

const SETUP_INITIAL_MESSAGE = "Help me set up this project.";

// The wizard's steps, in order, as analytics names them (flow 2). "More options" is not a
// step: opening it is counted as "more_options".
const CREATE_STEPS: readonly ProjectCreateStep[] = ["template", "name"];

async function setVisibility(projectId: string, visibility: Access) {
	const res = await fetch(
		`${API_BASE_URL}/v2/projects/${projectId}/visibility`,
		{
			body: JSON.stringify({ visibility }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, data);
	}
	return res.json();
}

/**
 * Creating a project: what the host is going to do, then a name. Two choices are enough;
 * the template's preset is applied by the server in the creating transaction.
 *
 * Step 1 "What are you going to do?": one card per template (TemplatePicker) and a quiet
 * "Start blank". A ?template=<key> link (workspace home's picker) arrives on step 2 with
 * that template chosen.
 *
 * Step 2 "Name": name and the optional project context, then Create. Key terms, access,
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

	const [step, setStep] = useState(linkedTemplate ? 1 : 0);
	const [template, setTemplate] = useState<TemplateKey | null>(linkedTemplate);
	const [name, setName] = useState("");
	const [context, setContext] = useState("");
	const [keyTerms, setKeyTerms] = useState("");
	const [access, setAccess] = useState<Access>("workspace");
	const [moreOpened, moreHandlers] = useDisclosure(false);
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);
	// Availability is not default-ness. The assistant setup starts an agentic
	// chat, so it follows AGENTIC_CHAT_IS_DEFAULT: off unless the host ticks it.
	// Pre-ticking it would fire an agentic run on every project created,
	// before the host has typed anything.
	const [setupWithAssistant, setSetupWithAssistant] = useState(
		AGENTIC_CHAT_IS_DEFAULT,
	);
	const templates = useProjectTemplates();
	const landing =
		templates.data?.find((tpl) => tpl.key === template)?.landing ?? "home";

	useDocumentTitle(t`Create project | dembrane`);

	// Funnel: each step shown, and the step a host left on without creating.
	const createStep = CREATE_STEPS[step] ?? "name";
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
	const wizardStarted = step > 0 || template !== null || name.trim() !== "";
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

	const chooseTemplate = (key: TemplateKey) => {
		setTemplate(key);
		track("project_template_selected", {
			surface: "create",
			template_key: key,
		});
		setStep(1);
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
				language: projectLanguageForLocale(language),
				name: name.trim(),
				templateKey: template ?? "blank",
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
				template_key: template ?? "blank",
			});
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

	if (!workspace) {
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

				<Stepper
					active={step}
					onStepClick={(i) => {
						if (i <= step) setStep(i);
					}}
					size="sm"
				>
					<Stepper.Step label={t`Template`}>
						<Stack gap="lg" mt="md">
							<TemplatePickerConnected
								value={template}
								onChange={setTemplate}
								onStartBlank={() => chooseTemplate("blank")}
							/>
							<Group gap="sm">
								<Button
									variant="filled"
									size="sm"
									disabled={!template}
									onClick={() => template && chooseTemplate(template)}
									data-testid="create-project-template-continue"
								>
									<Trans>Continue</Trans>
								</Button>
								<Button
									variant="subtle"
									color="gray"
									size="sm"
									onClick={handleCancel}
								>
									<Trans>Cancel</Trans>
								</Button>
							</Group>
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Name`}>
						<Stack gap="md" mt="md">
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

							<ProjectContextInput
								value={context}
								onChange={(e) => setContext(e.currentTarget.value)}
							/>

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
																	Only workspace admins and the people you
																	invite can open this project.
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
												<ReviewRow label={t`Template`}>
													{templateLabel}
												</ReviewRow>
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
									onClick={() => setStep(0)}
								>
									<Trans>Back</Trans>
								</Button>
							</Group>
						</Stack>
					</Stepper.Step>
				</Stepper>
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
