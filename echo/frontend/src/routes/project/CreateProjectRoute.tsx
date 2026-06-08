import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Center,
	Container,
	Group,
	Loader,
	Paper,
	Radio,
	Stack,
	Stepper,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { usePostHog } from "@posthog/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { useUpdateProjectByIdMutation } from "@/components/project/hooks";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useCreateWorkspaceProject } from "@/hooks/useWorkspaceProjects";
import { capacityShortFor, taglineFor } from "@/lib/tiers";

type Access = "workspace" | "private";

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
		throw new Error(data.detail || "Failed to set project visibility");
	}
	return res.json();
}

/**
 * Project creation wizard — mirrors the workspace creation wizard
 * (CreateWorkspaceRoute) so creating a project feels like creating a
 * workspace: a few deliberate steps instead of an instant POST.
 *
 * Three steps: Name & Context → Access → Review.
 *
 * Access step surfaces the workspace's current tier inline so the
 * creator can see what that tier includes before picking Private
 * (which requires Innovator+).
 */
export const CreateProjectRoute = () => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const posthog = usePostHog();
	const { workspace, workspaceId } = useWorkspace();
	const { language } = useLanguage();

	const [step, setStep] = useState(0);
	const [name, setName] = useState("");
	const [context, setContext] = useState("");
	const [access, setAccess] = useState<Access>("workspace");

	useDocumentTitle(t`New project | dembrane`);

	const tier = workspace?.tier ?? "pilot";
	const privateTiers = new Set(["innovator", "changemaker", "guardian"]);
	const privateAvailable = privateTiers.has(tier);

	const createProject = useCreateWorkspaceProject();
	const updateProject = useUpdateProjectByIdMutation();

	const submit = useMutation({
		mutationFn: async () => {
			const lang =
				language === "en-US" ? "en" : language === "nl-NL" ? "nl" : "en";

			const project = await createProject.mutateAsync({
				language: lang,
				name: name.trim(),
			});

			await updateProject.mutateAsync({
				id: project.id,
				payload: {
					context: context.trim() || null,
					default_conversation_ask_for_participant_name: true,
					default_conversation_tutorial_slug: "None",
					image_generation_model: "MODEST",
				},
			});

			if (access === "private" && privateAvailable) {
				await setVisibility(project.id, "private");
			}

			return project;
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSuccess: (project) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-projects"] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			posthog?.capture("project_created", { project_id: project.id });
			toast.success(t`Project created`);
			navigate(`/w/${workspaceId}/projects/${project.id}/home`);
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
		if (name.trim() || context.trim()) {
			modals.openConfirmModal({
				children: (
					<Text size="sm">
						<Trans>Your draft won't be saved.</Trans>
					</Text>
				),
				confirmProps: { color: "red" },
				labels: { cancel: t`Keep editing`, confirm: t`Discard` },
				onConfirm: backToProjects,
				title: t`Discard this project?`,
			});
		} else {
			backToProjects();
		}
	};

	if (!workspace) {
		return (
			<Center style={{ height: "60vh" }}>
				<Loader size="sm" color="gray" />
			</Center>
		);
	}

	const canAdvanceFromName = name.trim().length > 0;
	const canCreate = canAdvanceFromName;

	const tierCapacity = capacityShortFor(tier);
	const tierTagline = taglineFor(tier);

	return (
		<Container size="sm" py="xl" px="lg">
			<Stack gap={28}>
				<Stack gap={6}>
					<Title order={3} fw={400}>
						<Trans>New project</Trans>
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
					iconSize={28}
				>
					<Stepper.Step label={t`Name`}>
						<Stack gap={16} mt="md">
							<TextInput
								autoFocus
								label={t`Project name`}
								description={t`Name it after the topic, engagement, or question you're exploring.`}
								placeholder={t`e.g. Climate Listening, Q1 Research`}
								value={name}
								onChange={(e) => setName(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && canAdvanceFromName) {
										e.preventDefault();
										setStep(1);
									}
								}}
							/>

							<Textarea
								label={t`Description`}
								description={t`A short note on what this project is about. You can edit it later.`}
								placeholder={t`What are you trying to learn?`}
								value={context}
								onChange={(e) => setContext(e.currentTarget.value)}
								minRows={3}
								autosize
							/>
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Access`}>
						<Stack gap={14} mt="md">
							<Radio.Group
								label={t`Who can see this project?`}
								description={t`You can change this later in project settings.`}
								value={access}
								onChange={(v) => setAccess(v as Access)}
							>
								<Stack gap={10} mt={8}>
									<Radio
										value="workspace"
										label={
											<Stack gap={2}>
												<Text size="sm">
													<Trans>Open to the workspace</Trans>
												</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Everyone in {workspace.name} can find and open this
														project.
													</Trans>
												</Text>
											</Stack>
										}
									/>
									<Radio
										value="private"
										disabled={!privateAvailable}
										label={
											<Stack gap={2}>
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
														Only workspace admins and the people you invite can
														open this project.
													</Trans>
												</Text>
											</Stack>
										}
									/>
								</Stack>
							</Radio.Group>

							{/* Tier context — spells out what the workspace's tier
							    includes so the creator can see why Private is or
							    isn't available without leaving the wizard. */}
							<Alert color="gray" variant="light">
								<Stack gap={6}>
									<Text size="xs" fw={500}>
										<Trans>
											This workspace is on{" "}
											<span style={{ textTransform: "capitalize" }}>
												{tier}
											</span>
										</Trans>
									</Text>
									{tierCapacity && (
										<Text size="xs" c="dimmed">
											{tierCapacity}
											{tierTagline ? ` — ${tierTagline}` : ""}
										</Text>
									)}
									{!privateAvailable && (
										<Text size="xs" c="dimmed">
											<Trans>
												Private projects unlock on Innovator or higher.
											</Trans>
										</Text>
									)}
								</Stack>
							</Alert>
						</Stack>
					</Stepper.Step>

					<Stepper.Step label={t`Review`}>
						<Stack gap={14} mt="md">
							<Paper withBorder p="md" radius="sm">
								<Stack gap={10}>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={100}>
											<Trans>Name</Trans>
										</Text>
										<Text size="sm" fw={500}>
											{name.trim() || t`(missing)`}
										</Text>
									</Group>
									<Group gap={12} align="flex-start" wrap="nowrap">
										<Text size="xs" c="dimmed" w={100}>
											<Trans>Description</Trans>
										</Text>
										<Text
											size="sm"
											c={context.trim() ? undefined : "dimmed"}
											style={{ flex: 1, whiteSpace: "pre-wrap" }}
										>
											{context.trim() || t`(none)`}
										</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={100}>
											<Trans>Workspace</Trans>
										</Text>
										<Text size="sm">{workspace.name}</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={100}>
											<Trans>Access</Trans>
										</Text>
										<Text size="sm">
											{access === "workspace" ? (
												<Trans>Open to the workspace</Trans>
											) : (
												<Trans>Private</Trans>
											)}
										</Text>
									</Group>
									<Group gap={12} align="baseline">
										<Text size="xs" c="dimmed" w={100}>
											<Trans>Tier</Trans>
										</Text>
										<Text size="sm" style={{ textTransform: "capitalize" }}>
											{tier}
										</Text>
									</Group>
								</Stack>
							</Paper>
						</Stack>
					</Stepper.Step>
				</Stepper>

				<Group justify="space-between" mt="sm">
					<Button
						variant="outline"
						size="sm"
						onClick={step === 0 ? handleCancel : () => setStep(step - 1)}
					>
						{step === 0 ? <Trans>Cancel</Trans> : <Trans>Back</Trans>}
					</Button>
					{step < 2 ? (
						<Button
							size="sm"
							disabled={step === 0 && !canAdvanceFromName}
							onClick={() => setStep(step + 1)}
						>
							<Trans>Next</Trans>
						</Button>
					) : (
						<Button
							size="sm"
							loading={submit.isPending}
							disabled={!canCreate}
							onClick={() => submit.mutate()}
						>
							<Trans>Create project</Trans>
						</Button>
					)}
				</Group>
			</Stack>
		</Container>
	);
};
