import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Checkbox,
	Group,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import { useMemo, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { useUpdateProjectByIdMutation } from "@/components/project/hooks";
import { testId } from "@/lib/testUtils";

export type ProjectUpdateSuggestionChange = {
	field: string;
	current: unknown;
	proposed: unknown;
	reason: string;
};

export type ProjectUpdateSuggestion = {
	projectId: string;
	summary: string;
	changes: ProjectUpdateSuggestionChange[];
};

const formatValue = (value: unknown): string => {
	if (value === null || value === undefined || value === "") return "—";
	if (typeof value === "boolean") return value ? "on" : "off";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
};

const humanizeField = (field: string) =>
	field
		.replace(/^default_conversation_/, "portal ")
		.replace(/^is_/, "")
		.replace(/_/g, " ");

/**
 * Renders an agent-proposed settings diff. The agent never writes; the
 * user reviews each field (old value, proposed value, reason) and applies
 * the selected changes through the normal project PATCH under their own
 * session, so the v2 access ladder still gates the write.
 */
export const ProjectUpdateSuggestionCard = ({
	suggestion,
}: {
	suggestion: ProjectUpdateSuggestion;
}) => {
	const updateProjectMutation = useUpdateProjectByIdMutation();
	const [selected, setSelected] = useState<Record<string, boolean>>(() =>
		Object.fromEntries(suggestion.changes.map((c) => [c.field, true])),
	);
	const [applied, setApplied] = useState(false);
	const [dismissed, setDismissed] = useState(false);

	const selectedChanges = useMemo(
		() => suggestion.changes.filter((c) => selected[c.field]),
		[suggestion.changes, selected],
	);

	const handleApply = async () => {
		if (selectedChanges.length === 0) return;
		const payload = Object.fromEntries(
			selectedChanges.map((c) => [c.field, c.proposed]),
		);
		try {
			await updateProjectMutation.mutateAsync({
				id: suggestion.projectId,
				payload,
			});
			setApplied(true);
		} catch {
			toast.error(t`Could not apply the suggested changes`);
		}
	};

	return (
		<Box className="flex justify-start">
			<Paper
				className="w-full max-w-full rounded-md border border-slate-200/80 px-3 py-2 shadow-none md:max-w-[80%]"
				{...testId("agentic-project-update-suggestion")}
			>
				<Stack gap="sm">
					<Group justify="space-between" wrap="nowrap">
						<Text size="sm" fw={600}>
							<Trans>Suggested project changes</Trans>
						</Text>
						{applied ? (
							<Badge color="primary" variant="light">
								<Trans>Applied</Trans>
							</Badge>
						) : dismissed ? (
							<Badge color="gray" variant="light">
								<Trans>Dismissed</Trans>
							</Badge>
						) : null}
					</Group>
					{suggestion.summary && <Text size="sm">{suggestion.summary}</Text>}

					<Stack gap="xs">
						{suggestion.changes.map((change) => (
							<Group
								key={change.field}
								align="flex-start"
								gap="sm"
								wrap="nowrap"
							>
								{!applied && !dismissed && (
									<Checkbox
										size="sm"
										mt={2}
										checked={Boolean(selected[change.field])}
										onChange={(event) =>
											setSelected((prev) => ({
												...prev,
												[change.field]: event.currentTarget.checked,
											}))
										}
										{...testId(`suggestion-field-checkbox-${change.field}`)}
									/>
								)}
								<Stack gap={2} className="min-w-0 flex-1">
									<Text size="sm" fw={600}>
										{humanizeField(change.field)}
									</Text>
									<Text size="xs" className="break-words">
										<span className="text-red-700 line-through decoration-red-300">
											{formatValue(change.current)}
										</span>{" "}
										<span className="text-green-800">
											{formatValue(change.proposed)}
										</span>
									</Text>
									{change.reason && (
										<Text size="xs" fs="italic">
											{change.reason}
										</Text>
									)}
								</Stack>
							</Group>
						))}
					</Stack>

					{!applied && !dismissed && (
						<Group justify="flex-end" gap="sm">
							<Button
								variant="subtle"
								size="xs"
								onClick={() => setDismissed(true)}
								{...testId("suggestion-dismiss-button")}
							>
								<Trans>Dismiss</Trans>
							</Button>
							<Button
								size="xs"
								loading={updateProjectMutation.isPending}
								disabled={selectedChanges.length === 0}
								onClick={() => void handleApply()}
								{...testId("suggestion-apply-button")}
							>
								<Trans>Apply selected</Trans>
							</Button>
						</Group>
					)}
				</Stack>
			</Paper>
		</Box>
	);
};
