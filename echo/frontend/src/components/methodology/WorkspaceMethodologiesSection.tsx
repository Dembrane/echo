import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Group,
	Loader,
	Modal,
	Paper,
	Skeleton,
	Stack,
	Text,
	TextInput,
	Textarea,
	Title,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { testId } from "@/lib/testUtils";
import {
	type MethodologyListItem,
	useCreateMethodologyMutation,
	useEditMethodologyMutation,
	useMethodologies,
	useMethodologyDetail,
} from "./hooks";

type MethodologyForm = {
	name: string;
	description: string;
	framing: string;
	content: string;
	note: string;
};

const emptyForm: MethodologyForm = {
	name: "",
	description: "",
	framing: "",
	content: "",
	note: "",
};

const historyLabel = (count: number) =>
	count === 1 ? t`1 history entry` : t`${count} history entries`;

const safeText = (value: unknown): string =>
	typeof value === "string" ? value : "";

const safeCount = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

const contentToText = (content: unknown): string => {
	if (content === null || content === undefined) return "";
	if (typeof content === "string") return content;
	return JSON.stringify(content, null, 2);
};

const textToContent = (value: string): unknown => {
	const trimmed = value.trim();
	if (!trimmed) return "";
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
};

export const WorkspaceMethodologiesSection = ({
	workspaceId,
}: {
	workspaceId: string;
}) => {
	const methodologiesQuery = useMethodologies(workspaceId);
	const createMutation = useCreateMethodologyMutation(workspaceId);
	const editMutation = useEditMethodologyMutation(workspaceId);
	const [newOpen, setNewOpen] = useState(false);
	const [editing, setEditing] = useState<MethodologyListItem | null>(null);
	const [form, setForm] = useState<MethodologyForm>(emptyForm);
	const detailQuery = useMethodologyDetail(editing?.id);
	const latestContent = useMemo(
		() => detailQuery.data?.versions?.[0]?.content,
		[detailQuery.data?.versions],
	);

	useEffect(() => {
		if (!editing) return;
		setForm({
			name: detailQuery.data?.name ?? editing.name,
			description: detailQuery.data?.description ?? editing.description,
			framing: detailQuery.data?.framing ?? editing.framing,
			content: contentToText(latestContent),
			note: "",
		});
	}, [detailQuery.data, editing, latestContent]);

	const reset = () => {
		setForm(emptyForm);
		setEditing(null);
		setNewOpen(false);
	};

	const validateMetadata = () => {
		if (!form.name.trim() || !form.description.trim() || !form.framing.trim()) {
			toast.error(t`Add a name, description, and framing.`);
			return false;
		}
		return true;
	};

	const updateFormField = (field: keyof MethodologyForm, value: string) => {
		setForm((current) => ({
			...current,
			[field]: value,
		}));
	};

	const createMethodology = async () => {
		if (!validateMetadata()) return;
		try {
			await createMutation.mutateAsync({
				name: form.name.trim(),
				description: form.description.trim(),
				framing: form.framing.trim(),
			});
			reset();
		} catch {
			// Mutation shows the error toast.
		}
	};

	const saveMethodology = async () => {
		if (!editing || !validateMetadata()) return;
		try {
			await editMutation.mutateAsync({
				id: editing.id,
				name: form.name.trim(),
				description: form.description.trim(),
				framing: form.framing.trim(),
				content: textToContent(form.content),
				note: form.note.trim() || undefined,
			});
			reset();
		} catch {
			// Mutation shows the error toast.
		}
	};

	const methodologies = (methodologiesQuery.data ?? []).filter(
		(methodology): methodology is MethodologyListItem =>
			Boolean(methodology) && typeof methodology.id === "string",
	);

	return (
		<Paper withBorder radius="sm" p="md" {...testId("workspace-methodologies")}>
			<Stack gap="md">
				<Group justify="space-between" align="flex-start">
					<Stack gap={4}>
						<Title order={5} fw={400}>
							<Trans>Methodologies</Trans>
						</Title>
						<Text size="sm">
							<Trans>Named ways of working your team can reuse.</Trans>
						</Text>
					</Stack>
					<Button
						size="sm"
						onClick={() => {
							setForm(emptyForm);
							setNewOpen(true);
						}}
						{...testId("methodology-new-button")}
					>
						<Trans>New methodology</Trans>
					</Button>
				</Group>

				{methodologiesQuery.isLoading ? (
					<Stack gap="xs">
						<Skeleton height={20} width="44%" />
						<Skeleton height={16} width="82%" />
						<Skeleton height={16} width="28%" />
					</Stack>
				) : methodologiesQuery.isError ? (
					<Text size="sm">
						<Trans>Could not load methodologies.</Trans>
					</Text>
				) : methodologies.length === 0 ? (
					<Text size="sm">
						<Trans>No methodologies yet.</Trans>
					</Text>
				) : (
					<Stack gap={0}>
						{methodologies.map((methodology) => (
							<Group
								key={methodology.id}
								justify="space-between"
								align="flex-start"
								wrap="nowrap"
								p="sm"
								className="border-t"
								style={{ borderColor: "var(--mantine-color-primary-light)" }}
								{...testId(`methodology-row-${methodology.id}`)}
							>
								<Stack gap={4} style={{ minWidth: 0 }}>
									<Group gap="xs" wrap="wrap">
										<Text size="sm" fw={600}>
											{safeText(methodology.name) || t`Untitled methodology`}
										</Text>
										{methodology.is_seeded ? (
											<Badge size="xs" variant="outline">
												<Trans>dembrane</Trans>
											</Badge>
										) : null}
									</Group>
									<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
										{safeText(methodology.framing)}
									</Text>
									<Text size="xs">
										{historyLabel(safeCount(methodology.versions_count))}
									</Text>
								</Stack>
								{methodology.is_seeded ? (
									<Text size="xs">
										<Trans>Read-only</Trans>
									</Text>
								) : (
									<Button
										size="xs"
										variant="outline"
										onClick={() => setEditing(methodology)}
										{...testId(`methodology-edit-${methodology.id}`)}
									>
										<Trans>Edit</Trans>
									</Button>
								)}
							</Group>
						))}
					</Stack>
				)}
			</Stack>

			{newOpen ? (
				<Modal
					opened
					onClose={reset}
					title={t`New methodology`}
					trapFocus={false}
					{...testId("methodology-new-modal")}
				>
					<Stack gap="md" {...testId("methodology-new-form")}>
						<TextInput
							label={t`Name`}
							value={form.name}
							onChange={(event) =>
								updateFormField("name", event.currentTarget.value)
							}
							{...testId("methodology-new-name")}
						/>
						<TextInput
							label={t`Description`}
							value={form.description}
							onChange={(event) =>
								updateFormField("description", event.currentTarget.value)
							}
							{...testId("methodology-new-description")}
						/>
						<Textarea
							label={t`Framing`}
							value={form.framing}
							autosize
							minRows={3}
							onChange={(event) =>
								updateFormField("framing", event.currentTarget.value)
							}
							{...testId("methodology-new-framing")}
						/>
						<Group justify="flex-end" gap="xs" pt="xs">
							<Button
								variant="subtle"
								onClick={reset}
								{...testId("methodology-new-cancel")}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								loading={createMutation.isPending}
								onClick={() => void createMethodology()}
								{...testId("methodology-new-save")}
							>
								<Trans>Create</Trans>
							</Button>
						</Group>
					</Stack>
				</Modal>
			) : null}

			{editing ? (
				<Modal
					opened
					onClose={reset}
					title={t`Edit methodology`}
					size="lg"
					trapFocus={false}
					{...testId("methodology-edit-modal")}
				>
					<Stack gap="md" {...testId("methodology-edit-form")}>
						{detailQuery.isLoading ? (
							<Group gap="sm">
								<Loader size="xs" />
								<Text size="sm">
									<Trans>Loading methodology</Trans>
								</Text>
							</Group>
						) : null}
						<TextInput
							label={t`Name`}
							value={form.name}
							onChange={(event) =>
								updateFormField("name", event.currentTarget.value)
							}
							{...testId("methodology-edit-name")}
						/>
						<TextInput
							label={t`Description`}
							value={form.description}
							onChange={(event) =>
								updateFormField("description", event.currentTarget.value)
							}
							{...testId("methodology-edit-description")}
						/>
						<Textarea
							label={t`Framing`}
							value={form.framing}
							autosize
							minRows={3}
							onChange={(event) =>
								updateFormField("framing", event.currentTarget.value)
							}
							{...testId("methodology-edit-framing")}
						/>
						<Textarea
							label={t`Content`}
							value={form.content}
							autosize
							minRows={5}
							onChange={(event) =>
								updateFormField("content", event.currentTarget.value)
							}
							{...testId("methodology-edit-content")}
						/>
						<TextInput
							label={t`History note`}
							value={form.note}
							onChange={(event) =>
								updateFormField("note", event.currentTarget.value)
							}
							{...testId("methodology-edit-note")}
						/>
						<Group justify="flex-end" gap="xs" pt="xs">
							<Button
								variant="subtle"
								onClick={reset}
								{...testId("methodology-edit-cancel")}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								loading={editMutation.isPending}
								onClick={() => void saveMethodology()}
								{...testId("methodology-edit-save")}
							>
								<Trans>Save</Trans>
							</Button>
						</Group>
					</Stack>
				</Modal>
			) : null}
		</Paper>
	);
};
