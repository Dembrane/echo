import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Button,
	Checkbox,
	Group,
	Stack,
	Switch,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState } from "react";
import { Controller } from "react-hook-form";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { FormLabel } from "@/components/form/FormLabel";
import { CustomTopicModal } from "@/components/project/CustomTopicModal";
import {
	useCreateCustomTopicMutation,
	useDeleteCustomTopicMutation,
	useUpdateCustomTopicMutation,
} from "@/components/project/hooks";
import { KEY_TERMS_HASH } from "@/components/project/KeyTermsInput";
import { TopicIcon, topicDescription } from "@/components/verify/topics";
import { useLanguage } from "@/hooks/useLanguage";
import type { VerificationTopicMetadata } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { normalizeTopicList } from "../portalForm";
import { onOff, type SectionContent, type SectionProps } from "./types";

const LANGUAGE_TO_LOCALE: Record<string, string> = {
	cs: "cs-CZ",
	de: "de-DE",
	en: "en-US",
	es: "es-ES",
	fr: "fr-FR",
	it: "it-IT",
	nl: "nl-NL",
	uk: "uk-UA",
};

export interface TopicRow {
	key: string;
	label: string;
	description: string | null;
	is_custom: boolean;
	raw: VerificationTopicMetadata;
}

/** The topics as hosts read them: in the UI language, else the project's, else English. */
export const useTopicRows = (
	topics: SectionProps["verificationTopics"],
	projectLanguage: string,
): TopicRow[] => {
	const { iso639_1 } = useLanguage();
	const locale =
		LANGUAGE_TO_LOCALE[iso639_1 ?? ""] ??
		LANGUAGE_TO_LOCALE[projectLanguage] ??
		"en-US";
	return useMemo(
		() =>
			(topics?.available_topics ?? []).map((topic) => ({
				description: topic.is_custom ? null : topicDescription(topic.key),
				is_custom: !!topic.is_custom,
				key: topic.key,
				label:
					topic.translations?.[locale]?.label ??
					topic.translations?.["en-US"]?.label ??
					topic.key,
				raw: topic,
			})),
		[topics, locale],
	);
};

/**
 * Verify: on or off, which topics participants can choose, the host's own topics,
 * the reminder at finish, and the key terms the drafts spell by (read here, set in Brief).
 */
export const useVerifyOptions = ({
	project,
	page,
	verificationTopics,
	isVerificationTopicsLoading = false,
}: SectionProps): SectionContent => {
	const { control, formState, setValue, getValues } = page.form;
	const v = page.values;
	const rows = useTopicRows(verificationTopics, v.language);
	const custom = rows.filter((r) => r.is_custom);
	const selected = v.verification_topics ?? [];

	const createMutation = useCreateCustomTopicMutation();
	const updateMutation = useUpdateCustomTopicMutation();
	const deleteMutation = useDeleteCustomTopicMutation();
	const [modalOpened, modal] = useDisclosure(false);
	const [mode, setMode] = useState<"create" | "edit">("create");
	const [editing, setEditing] = useState<VerificationTopicMetadata | null>(
		null,
	);
	const [deleteKey, setDeleteKey] = useState<string | null>(null);

	const openCreate = useCallback(() => {
		setEditing(null);
		setMode("create");
		modal.open();
	}, [modal]);
	const openEdit = useCallback(
		(topic: VerificationTopicMetadata) => {
			setEditing(topic);
			setMode("edit");
			modal.open();
		},
		[modal],
	);

	const submitTopic = async (data: {
		label: string;
		prompt: string;
		icon: string;
		translations: Record<string, string>;
	}) => {
		try {
			const payload = {
				icon: data.icon || undefined,
				label: data.label,
				prompt: data.prompt,
				translations: data.translations,
			};
			if (mode === "create") {
				const result = await createMutation.mutateAsync({
					payload,
					projectId: project.id,
				});
				if (result?.selected_topics)
					setValue("verification_topics", result.selected_topics, {
						shouldDirty: true,
					});
			} else if (editing) {
				await updateMutation.mutateAsync({
					payload,
					projectId: project.id,
					topicKey: editing.key,
				});
			}
			modal.close();
		} catch {
			// The mutation's onError shows the toast.
		}
	};

	const confirmDelete = async () => {
		if (!deleteKey) return;
		const result = await deleteMutation.mutateAsync({
			projectId: project.id,
			topicKey: deleteKey,
		});
		if (result?.selected_topics)
			setValue("verification_topics", result.selected_topics, {
				shouldDirty: true,
			});
		else
			setValue(
				"verification_topics",
				(getValues("verification_topics") ?? []).filter((k) => k !== deleteKey),
				{ shouldDirty: true },
			);
		setDeleteKey(null);
	};

	const keyTerms = (project.default_conversation_transcript_prompt ?? "")
		.split(",")
		.map((term) => term.trim())
		.filter(Boolean);
	const briefLink = `/w/${project.workspace_id}/projects/${project.id}/brief#${KEY_TERMS_HASH}`;

	const topicsList = (
		<Controller
			name="verification_topics"
			control={control}
			render={({ field }) => (
				<Stack gap="xs">
					<FormLabel
						label={t`Verify topics`}
						isDirty={!!formState.dirtyFields.verification_topics}
						error={formState.errors.verification_topics?.message}
					/>
					<Text size="sm" c="dimmed">
						<Trans id="dashboard.dembrane.feature.verify.topic.select">
							Select which topics participants can use for "Verify".
						</Trans>
					</Text>
					{isVerificationTopicsLoading ? (
						<Text size="sm" c="dimmed">
							<Trans>Loading verify topics…</Trans>
						</Text>
					) : rows.length === 0 ? (
						<Text size="sm" c="dimmed">
							<Trans>No verify topics available.</Trans>
						</Text>
					) : (
						<Checkbox.Group
							value={field.value}
							onChange={(next) => {
								const updated = normalizeTopicList(next);
								if (updated.length === 0) {
									toast.error(
										t`At least one topic must be selected to enable Verify`,
									);
									return;
								}
								field.onChange(updated);
							}}
						>
							<Stack gap="sm">
								{rows.map((topic) => (
									<Checkbox
										key={topic.key}
										value={topic.key}
										label={
											<Group gap="xs" wrap="nowrap" component="span">
												<TopicIcon topicKey={topic.key} size={20} />
												<span>{topic.label}</span>
											</Group>
										}
										description={topic.description ?? undefined}
										{...testId(`portal-editor-verify-topic-${topic.key}`)}
									/>
								))}
							</Stack>
						</Checkbox.Group>
					)}
				</Stack>
			)}
		/>
	);

	const lastSelected = (key: string) =>
		selected.includes(key) && selected.length <= 1;

	return {
		extra: (
			<>
				<CustomTopicModal
					opened={modalOpened}
					onClose={modal.close}
					mode={mode}
					topic={editing}
					onSubmit={submitTopic}
					isLoading={createMutation.isPending || updateMutation.isPending}
				/>
				<ConfirmModal
					opened={deleteKey !== null}
					onClose={() => setDeleteKey(null)}
					title={t`Delete custom topic`}
					message={t`Are you sure you want to delete this custom topic? This cannot be undone.`}
					confirmLabel={<Trans>Delete</Trans>}
					confirmColor="red"
					loading={deleteMutation.isPending}
					onConfirm={confirmDelete}
					data-testid="custom-topic-delete-modal"
				/>
			</>
		),
		options: {
			"custom-topics": {
				body: (
					<Stack gap="sm">
						{custom.length === 0 ? (
							<Text size="sm" c="dimmed">
								<Trans>
									No topics of your own yet. Add one to ask participants to
									check something the built-in topics do not cover.
								</Trans>
							</Text>
						) : (
							custom.map((topic) => (
								<Group
									key={topic.key}
									justify="space-between"
									wrap="nowrap"
									gap="sm"
								>
									<Group gap="xs" wrap="nowrap">
										<TopicIcon topicKey={topic.key} size={20} />
										<Text size="sm">{topic.label}</Text>
									</Group>
									<Group gap={0} wrap="nowrap">
										<ActionIcon
											variant="transparent"
											aria-label={t`Edit topic`}
											onClick={() => openEdit(topic.raw)}
											{...testId(`custom-topic-edit-${topic.key}`)}
										>
											<PencilSimpleIcon size={20} />
										</ActionIcon>
										<Tooltip
											label={t`Select at least one other topic before deleting this one`}
											disabled={!lastSelected(topic.key)}
											multiline
											w={200}
										>
											<ActionIcon
												variant="transparent"
												aria-label={t`Delete topic`}
												c={lastSelected(topic.key) ? "dimmed" : "red"}
												disabled={lastSelected(topic.key)}
												onClick={() => setDeleteKey(topic.key)}
												{...testId(`custom-topic-delete-${topic.key}`)}
											>
												<TrashIcon size={20} />
											</ActionIcon>
										</Tooltip>
									</Group>
								</Group>
							))
						)}
						<Box>
							<Button
								variant="outline"
								leftSection={<PlusIcon size={20} />}
								onClick={openCreate}
								{...testId("portal-editor-add-custom-topic")}
							>
								<Trans>Add topic</Trans>
							</Button>
						</Box>
					</Stack>
				),
				summary:
					custom.length > 0
						? custom.map((topic) => topic.label).join(", ")
						: t`None`,
				title: t`Your own topics`,
			},
			enabled: {
				body: (
					<Stack gap="md">
						<Group gap="xs">
							<Badge color="mauve" c="graphite" size="sm">
								<Trans id="dashboard.dembrane.verify.beta">Beta</Trans>
							</Badge>
						</Group>
						<Text size="sm" c="dimmed">
							<Trans id="dashboard.dembrane.feature.verify.description">
								Enable this feature to allow participants to verify and approve
								"outcomes" from their submissions. This helps crystallize key
								ideas, concerns, or summaries. After the conversation, you can
								filter for discussions with verified outcomes and review them in
								the overview.
							</Trans>
						</Text>
						<Controller
							name="is_verify_enabled"
							control={control}
							render={({ field }) => (
								<Switch
									label={
										<FormLabel
											label={t`Enable Verify`}
											isDirty={formState.dirtyFields.is_verify_enabled}
											error={formState.errors.is_verify_enabled?.message}
										/>
									}
									checked={field.value}
									onChange={(e) => field.onChange(e.currentTarget.checked)}
									{...testId("portal-editor-make-concrete-switch")}
								/>
							)}
						/>
					</Stack>
				),
				summary: onOff(v.is_verify_enabled, t`On`, t`Off`),
				title: t({ id: "dashboard.dembrane.verify.title", message: "Verify" }),
			},
			"key-terms": {
				body: (
					<Stack gap="xs" {...testId("portal-editor-verify-key-terms")}>
						<Text size="sm">
							<Trans>
								The drafts participants check spell names and terms the way your
								key terms do.
							</Trans>
						</Text>
						<Text
							size="sm"
							className={keyTerms.length ? undefined : "app-muted"}
						>
							{keyTerms.length ? keyTerms.join(", ") : t`No key terms yet.`}
						</Text>
						<Box>
							<Anchor
								component={I18nLink}
								to={briefLink}
								size="sm"
								{...testId("portal-editor-verify-key-terms-link")}
							>
								<Trans>Change the key terms in Brief</Trans>
							</Anchor>
						</Box>
					</Stack>
				),
				summary: keyTerms.length ? keyTerms.join(", ") : t`No key terms yet.`,
				title: t`Key terms`,
			},
			remind: {
				body: (
					<Controller
						name="is_verify_on_finish_enabled"
						control={control}
						render={({ field }) => (
							<Switch
								label={
									<FormLabel
										label={t`Remind users to verify before finishing`}
										isDirty={formState.dirtyFields.is_verify_on_finish_enabled}
										error={
											formState.errors.is_verify_on_finish_enabled?.message
										}
									/>
								}
								description={t`When finishing the conversation, participants who haven't verified yet will be prompted to verify or skip`}
								checked={field.value}
								onChange={(e) => field.onChange(e.currentTarget.checked)}
								{...testId("portal-editor-verify-on-finish-switch")}
							/>
						)}
					/>
				),
				summary: onOff(v.is_verify_on_finish_enabled, t`On`, t`Off`),
				title: t`Remind at finish`,
			},
			topics: {
				body: topicsList,
				summary:
					rows
						.filter((r) => selected.includes(r.key))
						.map((r) => r.label)
						.join(", ") || t`None`,
				title: t`Verify topics`,
			},
		},
	};
};
