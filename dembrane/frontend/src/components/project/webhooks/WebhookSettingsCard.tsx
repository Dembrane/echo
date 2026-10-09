import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	ActionIcon,
	Anchor,
	Badge,
	Button,
	Checkbox,
	Code,
	Group,
	Modal,
	Paper,
	PasswordInput,
	Select,
	Skeleton,
	Stack,
	Switch,
	Table,
	Text,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	ArrowLeftIcon,
	ArrowSquareOutIcon,
	CopyIcon,
	PencilSimpleIcon,
	PlayIcon,
	PlusIcon,
	QuestionIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import type { Webhook, WebhookCreatePayload, WebhookEvent } from "@/lib/api";
import {
	useCopyableWebhooks,
	useCreateWebhookMutation,
	useDeleteWebhookMutation,
	useProjectWebhooks,
	useTestWebhookMutation,
	useUpdateWebhookMutation,
} from "../hooks";
import { ProjectSettingsSection } from "../ProjectSettingsSection";

// A function, so the labels are translated at render in the active locale.
const getWebhookEvents = (): {
	value: WebhookEvent;
	label: string;
	description: string;
}[] => [
	{
		description: t`When a participant starts a new conversation`,
		label: t`Conversation started`,
		value: "conversation.started",
	},
	{
		description: t`When all audio has been converted to text`,
		label: t`Conversation transcribed`,
		value: "conversation.transcribed",
	},
	{
		description: t`When the summary is generated`,
		label: t`Conversation summarized`,
		value: "conversation.summarized",
	},
	{
		description: t`When a report has been generated`,
		label: t`Report generated`,
		value: "report.generated",
	},
];

interface WebhookFormData {
	name: string;
	url: string;
	secret: string;
	events: WebhookEvent[];
}

interface WebhookFormModalProps {
	opened: boolean;
	onClose: () => void;
	projectId: string;
	webhook?: Webhook | null;
}

type ModalStep = "choose" | "copy" | "form";

const WebhookFormModal = ({
	opened,
	onClose,
	projectId,
	webhook,
}: WebhookFormModalProps) => {
	const isEditing = !!webhook;
	const createMutation = useCreateWebhookMutation();
	const updateMutation = useUpdateWebhookMutation();
	const { data: copyableWebhooks, isLoading: isLoadingCopyable } =
		useCopyableWebhooks(!isEditing ? projectId : undefined);

	const [step, setStep] = useState<ModalStep>("choose");

	const { control, handleSubmit, reset } = useForm<WebhookFormData>({
		defaultValues: {
			events: [
				"conversation.started",
				"conversation.transcribed",
				"conversation.summarized",
			],
			name: "",
			secret: "",
			url: "",
		},
	});

	// Build select options grouped by project
	const copyFromOptions = useMemo(() => {
		if (!copyableWebhooks?.length) return [];

		// Group webhooks by project
		const byProject = new Map<string, typeof copyableWebhooks>();
		for (const wh of copyableWebhooks) {
			const existing = byProject.get(wh.project_id) || [];
			existing.push(wh);
			byProject.set(wh.project_id, existing);
		}

		// Convert to grouped select options
		return Array.from(byProject.entries()).map(([_, webhooks]) => ({
			group: webhooks[0].project_name,
			items: webhooks.map((wh) => ({
				label: wh.name || wh.url || t`Unnamed webhook`,
				value: wh.id,
			})),
		}));
	}, [copyableWebhooks]);

	const hasCopyableWebhooks = copyFromOptions.length > 0;

	const handleCopyFrom = (webhookId: string | null) => {
		if (!webhookId || !copyableWebhooks) return;

		const source = copyableWebhooks.find((w) => w.id === webhookId);
		if (!source) return;

		reset({
			events: source.events || [
				"conversation.started",
				"conversation.transcribed",
				"conversation.summarized",
			],
			name: source.name || "",
			secret: "", // Never copy secrets
			url: source.url || "",
		});
		setStep("form");
	};

	const handleStartFresh = () => {
		reset({
			events: [
				"conversation.started",
				"conversation.transcribed",
				"conversation.summarized",
			],
			name: "",
			secret: "",
			url: "",
		});
		setStep("form");
	};

	// Reset form and step when modal opens/closes
	useEffect(() => {
		if (opened) {
			reset({
				events: webhook?.events || [
					"conversation.started",
					"conversation.transcribed",
					"conversation.summarized",
				],
				name: webhook?.name || "",
				secret: "",
				url: webhook?.url || "",
			});
			// When editing, go straight to form
			if (isEditing) {
				setStep("form");
			} else {
				setStep("choose");
			}
		}
	}, [opened, webhook, reset, isEditing]);

	// Redirect to form when on choose step but no copyable webhooks available
	useEffect(() => {
		if (
			step === "choose" &&
			!isEditing &&
			!isLoadingCopyable &&
			!hasCopyableWebhooks
		) {
			setStep("form");
		}
	}, [step, isEditing, isLoadingCopyable, hasCopyableWebhooks]);

	const onSubmit = async (data: WebhookFormData) => {
		try {
			if (isEditing && webhook) {
				await updateMutation.mutateAsync({
					payload: {
						name: data.name,
						url: data.url,
						...(data.secret ? { secret: data.secret } : {}),
						events: data.events,
					},
					projectId,
					webhookId: webhook.id,
				});
			} else {
				await createMutation.mutateAsync({
					payload: {
						name: data.name,
						url: data.url,
						...(data.secret ? { secret: data.secret } : {}),
						events: data.events,
					} as WebhookCreatePayload,
					projectId,
				});
			}
			reset();
			onClose();
		} catch (_error) {
			// Error handling is done in the mutation
		}
	};

	const isPending = createMutation.isPending || updateMutation.isPending;

	// Determine modal title based on step
	const getModalTitle = () => {
		if (isEditing) return <Trans>Edit webhook</Trans>;
		if (step === "copy") return <Trans>Clone from project</Trans>;
		return <Trans>Add webhook</Trans>;
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={getModalTitle()}
			size="md"
			centered
		>
			{/* Step: Choose between copy or fresh */}
			{step === "choose" && !isEditing && (
				<Stack gap="md">
					{isLoadingCopyable ? (
						<>
							<Skeleton height={80} />
							<Skeleton height={80} />
						</>
					) : hasCopyableWebhooks ? (
						<>
							<UnstyledButton
								p="lg"
								className="app-do"
								onClick={() => setStep("copy")}
							>
								<Group>
									<CopyIcon size={20} />
									<Stack gap="xs" style={{ flex: 1 }}>
										<Text>
											<Trans>Clone from another project</Trans>
										</Text>
										<Text size="sm" c="dimmed">
											<Trans>Re-use settings from an existing webhook</Trans>
										</Text>
									</Stack>
								</Group>
							</UnstyledButton>

							<UnstyledButton
								p="lg"
								className="app-do"
								onClick={handleStartFresh}
							>
								<Group>
									<PlusIcon size={20} />
									<Stack gap="xs" style={{ flex: 1 }}>
										<Text>
											<Trans>Start fresh</Trans>
										</Text>
										<Text size="sm" c="dimmed">
											<Trans>Set up a new webhook from scratch</Trans>
										</Text>
									</Stack>
								</Group>
							</UnstyledButton>
						</>
					) : null}
				</Stack>
			)}

			{/* Step: Select webhook to clone */}
			{step === "copy" && (
				<Stack gap="md">
					<div>
						<Button
							variant="subtle"
							color="gray"
							leftSection={<ArrowLeftIcon size={20} />}
							onClick={() => setStep("choose")}
							size="compact-sm"
							px={0}
						>
							<Trans>Back</Trans>
						</Button>
					</div>

					<Select
						label={t`Select a webhook to clone`}
						description={t`Choose from your other projects`}
						placeholder={t`Search webhooks...`}
						data={copyFromOptions}
						onChange={handleCopyFrom}
						searchable
						maxDropdownHeight={300}
						nothingFoundMessage={t`No webhooks found`}
					/>

					<Text size="xs" c="dimmed">
						<Trans>
							The webhook URL and events will be cloned. You'll need to re-enter
							the secret if one was configured.
						</Trans>
					</Text>
				</Stack>
			)}

			{/* Step: Form */}
			{step === "form" && (
				<form onSubmit={handleSubmit(onSubmit)}>
					<Stack gap="lg">
						{!isEditing && hasCopyableWebhooks && (
							<div>
								<Button
									variant="subtle"
									color="gray"
									leftSection={<ArrowLeftIcon size={20} />}
									onClick={() => setStep("choose")}
									size="compact-sm"
									px={0}
								>
									<Trans>Back</Trans>
								</Button>
							</div>
						)}
						<Stack gap="md">
							<Controller
								name="name"
								control={control}
								rules={{ required: t`Name is required` }}
								render={({ field, fieldState }) => (
									<TextInput
										label={t`Name`}
										description={t`A friendly name to identify this webhook`}
										placeholder={t`e.g., Slack notifications, Make workflow`}
										error={fieldState.error?.message}
										{...field}
									/>
								)}
							/>

							<Controller
								name="url"
								control={control}
								rules={{
									pattern: {
										message: t`URL must start with http:// or https://`,
										value: /^https?:\/\/.+/,
									},
									required: t`URL is required`,
								}}
								render={({ field, fieldState }) => (
									<TextInput
										label={t`Webhook URL`}
										description={t`The endpoint where we'll send the data. Get this from your receiving service (e.g., Zapier, Make, or your own server).`}
										placeholder="https://hooks.zapier.com/..."
										error={fieldState.error?.message}
										{...field}
									/>
								)}
							/>

							<Controller
								name="secret"
								control={control}
								render={({ field }) => (
									<PasswordInput
										label={
											<>
												<Trans>Secret</Trans>{" "}
												<Badge
													component="span"
													size="xs"
													variant="light"
													color="gray"
													ml="xs"
												>
													<Trans>Optional</Trans>
												</Badge>
											</>
										}
										description={t`For advanced users: A secret key to verify webhook authenticity. Only needed if your receiving service requires signature verification.`}
										placeholder={
											isEditing
												? t`Leave empty to keep existing`
												: t`Enter a secret key`
										}
										{...field}
									/>
								)}
							/>

							<Controller
								name="events"
								control={control}
								rules={{
									validate: (value) =>
										value.length > 0 || t`Select at least one event`,
								}}
								render={({ field, fieldState }) => (
									<Checkbox.Group
										label={t`Events to listen for`}
										description={t`Choose when you want to receive notifications`}
										error={fieldState.error?.message}
										value={field.value}
										onChange={(value) =>
											field.onChange(value as WebhookEvent[])
										}
									>
										<Stack gap="sm" mt="sm">
											{getWebhookEvents().map((event) => (
												<Checkbox
													key={event.value}
													value={event.value}
													label={event.label}
													description={event.description}
												/>
											))}
										</Stack>
									</Checkbox.Group>
								)}
							/>
						</Stack>

						<Group>
							<Button variant="filled" type="submit" loading={isPending}>
								{isEditing ? (
									<Trans>Save changes</Trans>
								) : (
									<Trans>Add webhook</Trans>
								)}
							</Button>
							<Button
								variant="subtle"
								color="gray"
								onClick={onClose}
								disabled={isPending}
							>
								<Trans>Cancel</Trans>
							</Button>
						</Group>
					</Stack>
				</form>
			)}
		</Modal>
	);
};

interface WebhookRowProps {
	webhook: Webhook;
	projectId: string;
	onEdit: (webhook: Webhook) => void;
}

const WebhookRow = ({ webhook, projectId, onEdit }: WebhookRowProps) => {
	const updateMutation = useUpdateWebhookMutation();
	const deleteMutation = useDeleteWebhookMutation();
	const testMutation = useTestWebhookMutation();
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

	// Use local state for optimistic toggle updates
	const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(
		null,
	);
	const isEnabled = optimisticEnabled ?? webhook.status === "published";

	// Reset optimistic state when webhook data changes from server
	useEffect(() => {
		setOptimisticEnabled(null);
	}, []);

	const handleToggle = async () => {
		const newStatus = isEnabled ? "draft" : "published";
		// Optimistically update UI
		setOptimisticEnabled(newStatus === "published");

		try {
			await updateMutation.mutateAsync({
				payload: {
					status: newStatus,
				},
				projectId,
				webhookId: webhook.id,
			});
			// Reset optimistic state after successful mutation (query will refresh)
			setOptimisticEnabled(null);
		} catch {
			// Revert optimistic state on error
			setOptimisticEnabled(null);
		}
	};

	const handleDelete = async () => {
		await deleteMutation.mutateAsync({ projectId, webhookId: webhook.id });
		setDeleteConfirmOpen(false);
	};

	const handleTest = async () => {
		await testMutation.mutateAsync({ projectId, webhookId: webhook.id });
	};

	const webhookEvents = getWebhookEvents();
	const eventBadges = webhook.events?.map((event) => {
		const eventConfig = webhookEvents.find((e) => e.value === event);
		return (
			<Badge key={event} size="xs" variant="light">
				{eventConfig?.label || event}
			</Badge>
		);
	});

	return (
		<>
			<Table.Tr>
				<Table.Td>
					<Stack gap="xs">
						<Text size="sm">{webhook.name || t`Unnamed webhook`}</Text>
						<Text size="xs" c="dimmed" lineClamp={1}>
							{webhook.url}
						</Text>
					</Stack>
				</Table.Td>
				<Table.Td>
					<Group gap="xs" wrap="wrap">
						{eventBadges}
					</Group>
				</Table.Td>
				<Table.Td>
					<Switch
						checked={isEnabled}
						onChange={handleToggle}
						disabled={updateMutation.isPending}
						size="sm"
					/>
				</Table.Td>
				<Table.Td>
					<Group gap="xs">
						<Tooltip label={t`Test webhook`}>
							<ActionIcon aria-label={t`Test webhook`}
								variant="subtle"
								onClick={handleTest}
								loading={testMutation.isPending}
							>
								<PlayIcon size={20} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={t`Edit`}>
							<ActionIcon aria-label={t`Edit`} variant="subtle" onClick={() => onEdit(webhook)}>
								<PencilSimpleIcon size={20} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={t`Delete`}>
							<ActionIcon aria-label={t`Delete`}
								variant="subtle"
								color="red"
								onClick={() => setDeleteConfirmOpen(true)}
							>
								<TrashIcon size={20} />
							</ActionIcon>
						</Tooltip>
					</Group>
				</Table.Td>
			</Table.Tr>

			<Modal
				opened={deleteConfirmOpen}
				onClose={() => setDeleteConfirmOpen(false)}
				title={t`Delete webhook`}
				size="sm"
				centered
			>
				<Stack>
					<Text>
						<Trans>
							Are you sure you want to delete the webhook "{webhook.name}"? This
							action cannot be undone.
						</Trans>
					</Text>
					<Group>
						<Button
							color="red"
							variant="filled"
							onClick={handleDelete}
							loading={deleteMutation.isPending}
						>
							<Trans>Delete</Trans>
						</Button>
						<Button
							variant="subtle"
							color="gray"
							onClick={() => setDeleteConfirmOpen(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
};

interface WebhookSectionProps {
	projectId: string;
}

const EXAMPLE_WEBHOOK_PAYLOAD = `{
  "event": "conversation.summarized",
  "timestamp": "2026-01-20T12:00:00.000Z",
  "conversation": {
    "id": "abc123-def456",
    "created_at": "2026-01-20T11:30:00.000Z",
    "updated_at": "2026-01-20T12:00:00.000Z",
    "participant_name": "Jane Smith",
    "duration": 245,
    "source": "PORTAL_AUDIO",
    "is_finished": true,
    "is_all_chunks_transcribed": true,
    "tags": ["feedback", "product"],
    "transcript": "Hello, I wanted to share my thoughts on...",
    "summary": "The participant shared positive feedback about...",
    "emails_csv": "jane@example.com,team@example.com"
  },
  "project": {
    "id": "proj-789",
    "name": "Customer Interviews",
    "language": "en"
  },
  "dashboardUrl": "https://app.example.com/en-US/w/ws-456/projects/proj-789/conversations/abc123-def456/overview"
}`;

interface WebhookHelpAccordionProps {
	onViewPayload: () => void;
}

const WebhookHelpAccordion = ({ onViewPayload }: WebhookHelpAccordionProps) => (
	<Accordion>
		<Accordion.Item value="what-are-webhooks">
			<Accordion.Control>
				<Group gap="xs">
					<QuestionIcon size={16} />
					<Text size="sm">
						<Trans>What are webhooks? (2 min read)</Trans>
					</Text>
				</Group>
			</Accordion.Control>
			<Accordion.Panel>
				<Stack gap="md">
					<Text size="sm">
						<Trans>
							Webhooks are automated messages sent from one app to another when
							something happens. Think of them as a "notification system" for
							your other tools.
						</Trans>
					</Text>

					<Text size="sm">
						<Trans>How it works:</Trans>
					</Text>
					<Stack gap="xs" pl="md">
						<Text size="sm">
							<Trans>
								1. You provide a URL where you want to receive notifications
							</Trans>
						</Text>
						<Text size="sm">
							<Trans>
								2. When a conversation or report event happens, we automatically
								send the data to your URL
							</Trans>
						</Text>
						<Text size="sm">
							<Trans>
								3. Your system receives the data and can act on it (e.g., save
								to a database, send an email, update a spreadsheet)
							</Trans>
						</Text>
					</Stack>

					<Text size="sm">
						<Trans>When are webhooks triggered?</Trans>
					</Text>
					<Stack gap="xs" pl="md">
						<Text size="sm">
							<strong>conversation.started</strong> —{" "}
							<Trans>
								When a participant opens the portal, enters their details, and
								begins a conversation
							</Trans>
						</Text>
						<Text size="sm">
							<strong>conversation.transcribed</strong> —{" "}
							<Trans>
								When all audio has been converted to text and the full
								transcript is available
							</Trans>
						</Text>
						<Text size="sm">
							<strong>conversation.summarized</strong> —{" "}
							<Trans>
								When the summary is ready (includes both transcript and summary)
							</Trans>
						</Text>
						<Text size="sm">
							<strong>report.generated</strong> —{" "}
							<Trans>When a report has been generated for the project</Trans>
						</Text>
					</Stack>

					<Text size="sm">
						<Trans>What data is sent?</Trans>
					</Text>
					<Stack gap="xs" pl="md">
						<Text size="sm">
							• <Trans>Participant name and email</Trans>
						</Text>
						<Text size="sm">
							• <Trans>Conversation tags</Trans>
						</Text>
						<Text size="sm">
							• <Trans>Full transcript (when available)</Trans>
						</Text>
						<Text size="sm">
							• <Trans>Summary (when available)</Trans>
						</Text>
						<Text size="sm">
							• <Trans>Timestamps and duration</Trans>
						</Text>
						<Text size="sm">
							• <Trans>Project name and ID</Trans>
						</Text>
						<Text size="sm">
							•{" "}
							<Trans>
								Dashboard URL (direct link to conversation overview)
							</Trans>
						</Text>
					</Stack>
					<Anchor component="button" size="sm" onClick={onViewPayload}>
						<Group gap="xs">
							<CopyIcon size={16} />
							<Trans>View example payload</Trans>
						</Group>
					</Anchor>

					<Text size="sm">
						<Trans>Common use cases:</Trans>
					</Text>
					<Stack gap="xs" pl="md">
						<Text size="sm">
							•{" "}
							<Trans>
								Automatically save transcripts to your CRM or database
							</Trans>
						</Text>
						<Text size="sm">
							•{" "}
							<Trans>
								Send Slack/Teams notifications when new conversations are
								completed
							</Trans>
						</Text>
						<Text size="sm">
							•{" "}
							<Trans>
								Trigger automated workflows in tools like Zapier, Make, or n8n
							</Trans>
						</Text>
						<Text size="sm">
							•{" "}
							<Trans>
								Build custom dashboards with real-time conversation data
							</Trans>
						</Text>
					</Stack>

					<Text size="sm">
						<Trans>Do I need this?</Trans>
					</Text>
					<Text size="sm">
						<Trans>
							If you're not sure, you probably don't need it yet. Webhooks are
							an advanced feature typically used by developers or teams with
							custom integrations. You can always set them up later.
						</Trans>
					</Text>

					<Anchor
						href="https://www.make.com/en/blog/what-are-webhooks"
						target="_blank"
						size="sm"
					>
						<Group gap="xs">
							<Trans>Learn more about webhooks</Trans>
							<ArrowSquareOutIcon size={16} />
						</Group>
					</Anchor>
				</Stack>
			</Accordion.Panel>
		</Accordion.Item>
	</Accordion>
);

export const WebhookSection = ({ projectId }: WebhookSectionProps) => {
	const { data: webhooks, isLoading, error } = useProjectWebhooks(projectId);
	const [formModalOpened, { open: openFormModal, close: closeFormModal }] =
		useDisclosure(false);
	const [
		payloadModalOpened,
		{ open: openPayloadModal, close: closePayloadModal },
	] = useDisclosure(false);
	const [editingWebhook, setEditingWebhook] = useState<Webhook | null>(null);
	const [copied, setCopied] = useState(false);

	const handleCopyPayload = () => {
		navigator.clipboard.writeText(EXAMPLE_WEBHOOK_PAYLOAD);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const handleAddWebhook = () => {
		setEditingWebhook(null);
		openFormModal();
	};

	const handleEditWebhook = (webhook: Webhook) => {
		setEditingWebhook(webhook);
		openFormModal();
	};

	const handleCloseModal = () => {
		setEditingWebhook(null);
		closeFormModal();
	};

	const hasWebhooks = webhooks && webhooks.length > 0;

	return (
		<ProjectSettingsSection
			title={
				<Group gap="xs">
					<Trans>Webhooks</Trans>
					<Badge size="sm" variant="light" color="gray">
						<Trans>Advanced</Trans>
					</Badge>
				</Group>
			}
			description={
				<Trans>
					Automatically send conversation data to your other tools and services
					when events occur.
				</Trans>
			}
			headerRight={
				hasWebhooks ? (
					<Button
						leftSection={<PlusIcon size={20} />}
						onClick={handleAddWebhook}
					>
						<Trans>Add webhook</Trans>
					</Button>
				) : undefined
			}
		>
			<Stack gap="lg">
				<WebhookHelpAccordion onViewPayload={openPayloadModal} />

				{isLoading ? (
					<Stack gap="xs">
						<Skeleton height={40} />
						<Skeleton height={40} />
						<Skeleton height={40} />
					</Stack>
				) : error ? (
					<ErrorNotice error={error} title={t`Failed to load webhooks`} />
				) : hasWebhooks ? (
					<Stack gap="md">
						<Paper withBorder style={{ overflow: "auto" }}>
							<Table striped highlightOnHover style={{ minWidth: 500 }}>
								<Table.Thead>
									<Table.Tr>
										<Table.Th>
											<Trans>Webhook</Trans>
										</Table.Th>
										<Table.Th>
											<Trans>Events</Trans>
										</Table.Th>
										<Table.Th>
											<Trans>Enabled</Trans>
										</Table.Th>
										<Table.Th>
											<Trans>Actions</Trans>
										</Table.Th>
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{webhooks.map((webhook) => (
										<WebhookRow
											key={webhook.id}
											webhook={webhook}
											projectId={projectId}
											onEdit={handleEditWebhook}
										/>
									))}
								</Table.Tbody>
							</Table>
						</Paper>
						<Text size="xs" c="dimmed">
							<Trans>
								Tip: Use the play button (▶) to send a test payload to your
								webhook and verify it's working correctly.
							</Trans>
						</Text>
					</Stack>
				) : (
					<Stack gap="sm" align="flex-start">
						<Text size="sm" c="dimmed">
							<Trans>
								No webhooks yet. Add a webhook to automatically receive
								conversation data when events happen.
							</Trans>
						</Text>
						<Button
							leftSection={<PlusIcon size={20} />}
							onClick={handleAddWebhook}
						>
							<Trans>Add webhook</Trans>
						</Button>
					</Stack>
				)}

				<WebhookFormModal
					opened={formModalOpened}
					onClose={handleCloseModal}
					projectId={projectId}
					webhook={editingWebhook}
				/>

				<Paper p="sm" withBorder>
					<Stack gap="xs">
						<Text size="sm">
							<Trans>Using webhooks? We'd love to hear from you</Trans>
						</Text>
						<Text size="sm">
							<Trans>
								If you're setting up webhook integrations, we'd love to learn
								about your use case. We're also building observability features
								including audit logs and delivery tracking.
							</Trans>
						</Text>
						<Group gap="md">
							<Anchor
								href="https://cal.com/sameer-dembrane"
								target="_blank"
								size="sm"
							>
								<Group gap="xs">
									<Trans>Book a call</Trans>
									<ArrowSquareOutIcon size={16} />
								</Group>
							</Anchor>
						</Group>
					</Stack>
				</Paper>

				<Modal
					opened={payloadModalOpened}
					onClose={closePayloadModal}
					title={t`Example webhook payload`}
					size="lg"
				>
					<Stack gap="md">
						<Text size="sm" c="dimmed">
							<Trans>
								This is an example of the JSON data sent to your webhook URL
								when a conversation is summarized.
							</Trans>
						</Text>
						<Code block fz="xs" style={{ maxHeight: 400, overflow: "auto" }}>
							{EXAMPLE_WEBHOOK_PAYLOAD}
						</Code>
						<Group>
							<Button
								variant="filled"
								leftSection={<CopyIcon size={20} />}
								onClick={handleCopyPayload}
							>
								{copied ? (
									<Trans>Copied</Trans>
								) : (
									<Trans>Copy to clipboard</Trans>
								)}
							</Button>
						</Group>
					</Stack>
				</Modal>
			</Stack>
		</ProjectSettingsSection>
	);
};
