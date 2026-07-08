import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Collapse,
	Group,
	Paper,
	Skeleton,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ProjectSettingsSection } from "@/components/project/ProjectSettingsSection";
import {
	type ProjectGoalRevision,
	useProjectGoal,
	useSaveProjectGoalMutation,
} from "./hooks";

const setByLabel = (setBy: string) => {
	switch (setBy) {
		case "interview":
			return t`interview`;
		case "loop":
			return t`loop`;
		case "host-edit":
		case "you":
			return t`you`;
		default:
			return setBy;
	}
};

const relativeSetLine = (revision: ProjectGoalRevision) => {
	const date = new Date(revision.created_at);
	const relative = Number.isNaN(date.getTime())
		? t`recently`
		: formatDistanceToNow(date, { addSuffix: true });
	return t`set by ${setByLabel(revision.set_by)} ${relative}`;
};

export const ProjectGoalSection = ({ projectId }: { projectId: string }) => {
	const goalQuery = useProjectGoal(projectId);
	const saveGoalMutation = useSaveProjectGoalMutation(projectId);
	const [editing, setEditing] = useState(false);
	const [content, setContent] = useState("");
	const [historyOpen, setHistoryOpen] = useState(false);

	useEffect(() => {
		if (!editing) setContent(goalQuery.data?.current?.content ?? "");
	}, [goalQuery.data?.current?.content, editing]);

	const current = goalQuery.data?.current ?? null;
	const revisions = goalQuery.data?.revisions ?? [];

	const handleSave = async () => {
		const next = content.trim();
		if (!next) {
			toast.error(t`Add a project goal before saving.`);
			return;
		}
		try {
			await saveGoalMutation.mutateAsync(next);
			setEditing(false);
			toast.success(t`Goal saved`);
		} catch {
			// The mutation surfaces its own error toast.
		}
	};

	return (
		<ProjectSettingsSection
			title={<Trans>Project goal</Trans>}
			description={
				<Trans>
					The goal guides reports, canvases, and assistant suggestions for this
					project.
				</Trans>
			}
			headerRight={
				goalQuery.data?.isDevFixture ? (
					<Badge variant="outline">
						<Trans>Fixture</Trans>
					</Badge>
				) : null
			}
		>
			{goalQuery.isLoading ? (
				<Stack gap="sm">
					<Skeleton height={24} width="72%" />
					<Skeleton height={14} width="34%" />
				</Stack>
			) : goalQuery.isError ? (
				<Text size="sm">
					<Trans>Could not load this project's goal.</Trans>
				</Text>
			) : (
				<Stack gap="md">
					{current ? (
						<Paper withBorder className="rounded-md px-4 py-4">
							<Stack gap="sm">
								<Text size="lg" style={{ whiteSpace: "pre-wrap" }}>
									{current.content}
								</Text>
								<Text size="xs" fs="italic">
									{relativeSetLine(current)}
								</Text>
							</Stack>
						</Paper>
					) : (
						<Text size="sm">
							<Trans>
								No goal yet. Set one here, or let the assistant interview you in
								chat.
							</Trans>
						</Text>
					)}

					{editing ? (
						<Stack gap="sm">
							<Textarea
								label={t`Goal`}
								value={content}
								onChange={(event) => setContent(event.currentTarget.value)}
								autosize
								minRows={3}
								maxRows={8}
							/>
							<Group justify="flex-end" gap="xs">
								<Button
									variant="subtle"
									size="sm"
									onClick={() => {
										setContent(current?.content ?? "");
										setEditing(false);
									}}
								>
									<Trans>Cancel</Trans>
								</Button>
								<Button
									size="sm"
									loading={saveGoalMutation.isPending}
									onClick={() => void handleSave()}
								>
									<Trans>Save</Trans>
								</Button>
							</Group>
						</Stack>
					) : (
						<Button
							variant="outline"
							size="sm"
							className="self-start"
							onClick={() => {
								setContent(current?.content ?? "");
								setEditing(true);
							}}
						>
							{current ? <Trans>Edit goal</Trans> : <Trans>Set goal</Trans>}
						</Button>
					)}

					{revisions.length > 0 ? (
						<Stack gap="xs">
							<Button
								variant="subtle"
								size="xs"
								className="self-start"
								leftSection={
									historyOpen ? (
										<IconChevronDown size={14} />
									) : (
										<IconChevronRight size={14} />
									)
								}
								onClick={() => setHistoryOpen((value) => !value)}
							>
								<Trans>Revision history</Trans>
							</Button>
							<Collapse in={historyOpen}>
								<Stack
									gap="sm"
									className="border-l-2 pl-3"
									style={{ borderColor: "var(--mantine-color-primary-light)" }}
								>
									{revisions.map((revision) => (
										<Stack key={revision.id} gap={2}>
											<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
												{revision.content}
											</Text>
											<Text size="xs">
												{new Date(revision.created_at).toLocaleString()}
											</Text>
										</Stack>
									))}
								</Stack>
							</Collapse>
						</Stack>
					) : null}
				</Stack>
			)}
		</ProjectSettingsSection>
	);
};
