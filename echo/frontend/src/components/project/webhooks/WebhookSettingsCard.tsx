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
	Loader,
	Modal,
	Paper,
	PasswordInput,
	Stack,
	Switch,
	Table,
	Text,
	ThemeIcon,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconCopy,
	IconEdit,
	IconExternalLink,
	IconHelpCircle,
	IconPlayerPlay,
	IconPlus,
	IconTrash,
	IconWebhook,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import type { Webhook, WebhookCreatePayload, WebhookEvent } from "@/lib/api";
import {
	useCreateWebhookMutation,
	useDeleteWebhookMutation,
	useProjectWebhooks,
	useTestWebhookMutation,
	useUpdateWebhookMutation,
} from "../hooks";
import { ProjectSettingsSection } from "../ProjectSettingsSection";

const WEBHOOK_EVENTS: {
	value: WebhookEvent;
	label: string;
	description: string;
}[] = [
	{
		description: "When a participant starts a new conversation",
		label: "Conversation Created",
		value: "conversation.created",
	},
	{
		description: "When all audio has been converted to text",
		label: "Conversation Transcribed",
		value: "conversation.transcribed",
	},
	{
		description: "When the summary is generated",
		label: "Conversation Summarized",
		value: "conversation.summarized",
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

const WebhookFormModal = ({
	opened,
	onClose,
	projectId,
	webhook,
}: WebhookFormModalProps) => {
	const isEditing = !!webhook;
	const createMutation = useCreateWebhookMutation();
	const updateMutation = useUpdateWebhookMutation();

	const { control, handleSubmit, reset } = useForm<WebhookFormData>({
		defaultValues: {
			events: [
				"conversation.created",
				"conversation.transcribed",
				"conversation.summarized",
			],
			name: "",
			secret: "",
			url: "",
		},
	});

	// Reset form when webhook changes (editing) or modal opens
	useEffect(() => {
		if (opened) {
			reset({
				events: webhook?.events || [
					"conversation.created",
					"conversation.transcribed",
					"conversation.summarized",
				],
				name: webhook?.name || "",
				secret: "",
				url: webhook?.url || "",
			});
		}
	}, [opened, webhook, reset]);

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

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Group gap="xs">
					<IconWebhook size={20} />
					<Text fw={600}>
						{isEditing ? (
							<Trans>Edit Webhook</Trans>
						) : (
							<Trans>Add Webhook</Trans>
						)}
					</Text>
				</Group>
			}
			size="md"
			centered
		>
			<form onSubmit={handleSubmit(onSubmit)}>
				<Stack gap="lg">
					<Controller
						name="name"
						control={control}
						rules={{ required: t`Name is required` }}
						render={({ field, fieldState }) => (
							<Stack gap={4}>
								<Text size="sm" fw={500}>
									<Trans>Name</Trans>
								</Text>
								<Text size="xs" c="dimmed">
									<Trans>A friendly name to identify this webhook</Trans>
								</Text>
								<input
									type="text"
									placeholder={t`e.g., Slack Notifications, Make Workflow`}
									className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
									style={{ backgroundColor: "var(--app-background)" }}
									{...field}
								/>
								{fieldState.error && (
									<Text size="xs" c="red">
										{fieldState.error.message}
									</Text>
								)}
							</Stack>
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
							<Stack gap={4}>
								<Text size="sm" fw={500}>
									<Trans>Webhook URL</Trans>
								</Text>
								<Text size="xs" c="dimmed">
									<Trans>
										The endpoint where we'll send the data. Get this from your
										receiving service (e.g., Zapier, Make, or your own server).
									</Trans>
								</Text>
								<input
									type="text"
									placeholder="https://hooks.zapier.com/..."
									className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
									style={{ backgroundColor: "var(--app-background)" }}
									{...field}
								/>
								{fieldState.error && (
									<Text size="xs" c="red">
										{fieldState.error.message}
									</Text>
								)}
							</Stack>
						)}
					/>

					<Controller
						name="secret"
						control={control}
						render={({ field }) => (
							<Stack gap={4}>
								<Group gap={4}>
									<Text size="sm" fw={500}>
										<Trans>Secret</Trans>
									</Text>
									<Badge size="xs" variant="light" color="gray">
										<Trans>Optional</Trans>
									</Badge>
								</Group>
								<Text size="xs" c="dimmed">
									<Trans>
										For advanced users: A secret key to verify webhook
										authenticity. Only needed if your receiving service requires
										signature verification.
									</Trans>
								</Text>
								<PasswordInput
									placeholder={
										isEditing
											? t`Leave empty to keep existing`
											: t`Enter a secret key`
									}
									{...field}
								/>
							</Stack>
						)}
					/>

					<Stack gap="xs">
						<Text size="sm" fw={500}>
							<Trans>Events to Listen For</Trans>
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>Choose when you want to receive notifications</Trans>
						</Text>
						<Controller
							name="events"
							control={control}
							rules={{
								validate: (value) =>
									value.length > 0 || t`Select at least one event`,
							}}
							render={({ field, fieldState }) => (
								<Stack gap="sm">
									{WEBHOOK_EVENTS.map((event) => (
										<Paper key={event.value} p="sm" withBorder radius="md">
											<Checkbox
												label={
													<Stack gap={2}>
														<Text size="sm" fw={500}>
															{event.label}
														</Text>
														<Text size="xs" c="dimmed">
															{event.description}
														</Text>
													</Stack>
												}
												checked={field.value.includes(event.value)}
												onChange={(e) => {
													if (e.currentTarget.checked) {
														field.onChange([...field.value, event.value]);
													} else {
														field.onChange(
															field.value.filter((v) => v !== event.value),
														);
													}
												}}
												styles={{
													body: { alignItems: "flex-start" },
													input: { marginTop: 2 },
												}}
											/>
										</Paper>
									))}
									{fieldState.error && (
										<Text size="xs" c="red">
											{fieldState.error.message}
										</Text>
									)}
								</Stack>
							)}
						/>
					</Stack>

					<Group justify="flex-end" mt="md">
						<Button variant="subtle" onClick={onClose} disabled={isPending}>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" loading={isPending}>
							{isEditing ? (
								<Trans>Save Changes</Trans>
							) : (
								<Trans>Create Webhook</Trans>
							)}
						</Button>
					</Group>
				</Stack>
			</form>
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

	const eventBadges = webhook.events?.map((event) => {
		const eventConfig = WEBHOOK_EVENTS.find((e) => e.value === event);
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
					<Stack gap={4}>
						<Text size="sm" fw={500}>
							{webhook.name || "Unnamed Webhook"}
						</Text>
						<Text size="xs" c="dimmed" lineClamp={1}>
							{webhook.url}
						</Text>
					</Stack>
				</Table.Td>
				<Table.Td>
					<Group gap={4} wrap="wrap">
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
						<Tooltip label={t`Test Webhook`}>
							<ActionIcon
								variant="subtle"
								color="blue"
								onClick={handleTest}
								loading={testMutation.isPending}
							>
								<IconPlayerPlay size={16} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={t`Edit`}>
							<ActionIcon variant="subtle" onClick={() => onEdit(webhook)}>
								<IconEdit size={16} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={t`Delete`}>
							<ActionIcon
								variant="subtle"
								color="red"
								onClick={() => setDeleteConfirmOpen(true)}
							>
								<IconTrash size={16} />
							</ActionIcon>
						</Tooltip>
					</Group>
				</Table.Td>
			</Table.Tr>

			<Modal
				opened={deleteConfirmOpen}
				onClose={() => setDeleteConfirmOpen(false)}
				title={t`Delete Webhook`}
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
					<Group justify="flex-end">
						<Button
							variant="subtle"
							onClick={() => setDeleteConfirmOpen(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							color="red"
							onClick={handleDelete}
							loading={deleteMutation.isPending}
						>
							<Trans>Delete</Trans>
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
    "participant_email": "jane@example.com",
    "duration": 245,
    "source": "PORTAL_AUDIO",
    "is_finished": true,
    "is_all_chunks_transcribed": true,
    "tags": ["feedback", "product"],
    "transcript": "Hello, I wanted to share my thoughts on...",
    "summary": "The participant shared positive feedback about..."
  },
  "project": {
    "id": "proj-789",
    "name": "Customer Interviews",
    "language": "en"
  }
}`;

interface WebhookHelpAccordionProps {
	onViewPayload: () => void;
}

const WebhookHelpAccordion = ({ onViewPayload }: WebhookHelpAccordionProps) => (
	<Accordion variant="contained" radius="md">
		<Accordion.Item value="what-are-webhooks">
			<Accordion.Control>
				<Group gap={6}>
					<IconHelpCircle size={18} style={{ opacity: 0.7 }} />
					<Text size="sm" fw={500}>
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

					<Text size="sm" fw={500}>
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
								2. When a conversation event happens, we automatically send the
								conversation data to your URL
							</Trans>
						</Text>
						<Text size="sm">
							<Trans>
								3. Your system receives the data and can act on it (e.g., save
								to a database, send an email, update a spreadsheet)
							</Trans>
						</Text>
					</Stack>

					<Text size="sm" fw={500}>
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
					</Stack>
					<Anchor component="button" size="sm" onClick={onViewPayload}>
						<Group gap={4}>
							<IconCopy size={14} />
							<Trans>View example payload</Trans>
						</Group>
					</Anchor>

					<Text size="sm" fw={500}>
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

					<Text size="sm" fw={500}>
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
						<Group gap={4}>
							<Trans>Learn more about webhooks</Trans>
							<IconExternalLink size={14} />
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
						leftSection={<IconPlus size={16} />}
						variant="outline"
						onClick={handleAddWebhook}
					>
						<Trans>Add Webhook</Trans>
					</Button>
				) : undefined
			}
		>
			<Stack gap="lg">
				<WebhookHelpAccordion onViewPayload={openPayloadModal} />

				{isLoading ? (
					<Group justify="center" py="xl">
						<Loader size="sm" />
					</Group>
				) : error ? (
					<Paper p="md" withBorder>
						<Text c="red" ta="center">
							<Trans>Failed to load webhooks</Trans>
						</Text>
					</Paper>
				) : hasWebhooks ? (
					<Stack gap="md">
						<Paper withBorder radius="md" style={{ overflow: "auto" }}>
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
					<Paper
						p="xl"
						withBorder
						radius="md"
						style={{ backgroundColor: "var(--mantine-color-gray-0)" }}
					>
						<Stack align="center" gap="md">
							<ThemeIcon size={60} radius="xl" variant="light" color="gray">
								<IconWebhook size={32} stroke={1.5} />
							</ThemeIcon>
							<Stack gap={4} align="center">
								<Text fw={500}>
									<Trans>No webhooks configured</Trans>
								</Text>
								<Text size="sm" c="dimmed" ta="center" maw={400}>
									<Trans>
										Ready to connect your tools? Add a webhook to automatically
										receive conversation data when events happen.
									</Trans>
								</Text>
							</Stack>
							<Button
								rightSection={<IconPlus size={16} />}
								variant="filled"
								onClick={handleAddWebhook}
							>
								<Trans>Add Your First Webhook</Trans>
							</Button>
						</Stack>
					</Paper>
				)}

				<WebhookFormModal
					opened={formModalOpened}
					onClose={handleCloseModal}
					projectId={projectId}
					webhook={editingWebhook}
				/>

				<Paper p="sm" withBorder radius="md" bg="blue.0">
					<Stack gap="xs">
						<Text size="sm" fw={500}>
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
								<Group gap={4}>
									<Trans>Book a call</Trans>
									<IconExternalLink size={14} />
								</Group>
							</Anchor>
						</Group>
					</Stack>
				</Paper>

				<Modal
					opened={payloadModalOpened}
					onClose={closePayloadModal}
					title={t`Example Webhook Payload`}
					size="lg"
				>
					<Stack gap="md">
						<Text size="sm" c="dimmed">
							<Trans>
								This is an example of the JSON data sent to your webhook URL
								when a conversation is summarized.
							</Trans>
						</Text>
						<Code
							block
							style={{ fontSize: 12, maxHeight: 400, overflow: "auto" }}
						>
							{EXAMPLE_WEBHOOK_PAYLOAD}
						</Code>
						<Button
							leftSection={<IconCopy size={16} />}
							onClick={handleCopyPayload}
							color={copied ? "green" : "blue"}
						>
							{copied ? (
								<Trans>Copied!</Trans>
							) : (
								<Trans>Copy to Clipboard</Trans>
							)}
						</Button>
					</Stack>
				</Modal>
			</Stack>
		</ProjectSettingsSection>
	);
};
