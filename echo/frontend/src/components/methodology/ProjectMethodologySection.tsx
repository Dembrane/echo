import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Group,
	Paper,
	Select,
	Skeleton,
	Stack,
	Text,
} from "@mantine/core";
import { ProjectSettingsSection } from "@/components/project/ProjectSettingsSection";
import { testId } from "@/lib/testUtils";
import {
	type MethodologyListItem,
	useMethodologies,
	useSelectProjectMethodologyMutation,
} from "./hooks";

type RelatedId = string | { id?: string | null } | null | undefined;

const relatedId = (value: RelatedId): string | null => {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && typeof value.id === "string") {
		return value.id;
	}
	return null;
};

const optionLabel = (methodology: MethodologyListItem) =>
	methodology.is_seeded ? t`${methodology.name} (default)` : methodology.name;

type ProjectMethodologySectionProps = {
	project: {
		id: string;
		workspace_id?: RelatedId;
		methodology_version_id?: RelatedId;
	};
};

export const ProjectMethodologySection = ({
	project,
}: ProjectMethodologySectionProps) => {
	const workspaceId = relatedId(project.workspace_id);
	const currentVersionId = relatedId(project.methodology_version_id);
	const methodologiesQuery = useMethodologies(workspaceId);
	const selectMutation = useSelectProjectMethodologyMutation(
		project.id,
		workspaceId ?? "",
	);

	const methodologies = methodologiesQuery.data ?? [];
	const seeded = methodologies.find((methodology) => methodology.is_seeded);
	const selected =
		methodologies.find(
			(methodology) => methodology.latest_version?.id === currentVersionId,
		) ??
		(!currentVersionId ? seeded : undefined) ??
		null;

	const selectData = methodologies
		.filter((methodology) => methodology.latest_version?.id)
		.map((methodology) => ({
			label: optionLabel(methodology),
			value: methodology.latest_version?.id ?? "",
		}));

	const handleChange = async (value: string | null) => {
		if (!value || value === currentVersionId) return;
		await selectMutation.mutateAsync(value);
	};

	return (
		<ProjectSettingsSection
			title={<Trans>Methodology</Trans>}
			description={
				<Trans>
					The methodology is the way this project is set up and guided.
				</Trans>
			}
			headerRight={
				methodologiesQuery.data?.some(
					(methodology) => methodology.isDevFixture,
				) ? (
					<Badge variant="outline">
						<Trans>Fixture</Trans>
					</Badge>
				) : null
			}
		>
			{!workspaceId ? (
				<Text size="sm">
					<Trans>This project is not attached to a workspace.</Trans>
				</Text>
			) : methodologiesQuery.isLoading ? (
				<Stack gap="sm">
					<Skeleton height={18} width="38%" />
					<Skeleton height={40} width="100%" />
					<Skeleton height={16} width="74%" />
				</Stack>
			) : methodologiesQuery.isError ? (
				<Text size="sm">
					<Trans>Could not load methodologies.</Trans>
				</Text>
			) : (
				<Stack gap="sm">
					<Select
						label={t`Methodology`}
						data={selectData}
						value={selected?.latest_version?.id ?? currentVersionId ?? null}
						onChange={(value) => void handleChange(value)}
						disabled={selectMutation.isPending || selectData.length === 0}
						placeholder={t`Choose a methodology`}
						{...testId("project-methodology-select")}
					/>
					<Paper withBorder className="rounded-md px-4 py-3">
						<Stack gap="xs">
							<Group gap="xs" wrap="wrap">
								<Text
									size="sm"
									fw={600}
									{...testId("project-methodology-current")}
								>
									{selected ? optionLabel(selected) : t`dembrane - the default`}
								</Text>
								{selected?.is_seeded ? (
									<Badge size="xs" variant="outline">
										<Trans>dembrane</Trans>
									</Badge>
								) : null}
							</Group>
							{selected?.framing ? (
								<Text
									size="sm"
									style={{ whiteSpace: "pre-wrap" }}
									{...testId("project-methodology-framing")}
								>
									{selected.framing}
								</Text>
							) : null}
						</Stack>
					</Paper>
				</Stack>
			)}
		</ProjectSettingsSection>
	);
};
