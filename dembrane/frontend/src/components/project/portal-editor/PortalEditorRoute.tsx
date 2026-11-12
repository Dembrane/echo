import { t } from "@lingui/core/macro";
import { Stack } from "@mantine/core";
import { useMemo } from "react";
import { Navigate, useParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { PageContainer } from "@/components/layout/PageContainer";
import {
	useProjectById,
	useVerificationTopicsQuery,
} from "@/components/project/hooks";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isReadOnlyRole } from "@/lib/roles";
import { useSettingsCatalog } from "./i18n";
import { PortalSectionEditor } from "./PortalSectionEditor/PortalSectionEditor";
import { isSectionKey, PORTAL_PROJECT_FIELDS } from "./portalForm";

/**
 * The portal editor (ECHO-1060), one page per part of the portal at
 * …/portal/:section/:option. Loads the project's portal fields once (each page reads its
 * own from the same query) and the Verify topics on the Verify page only.
 */
export const PortalEditorRoute = () => {
	const { projectId, section, option } = useParams();
	const ready = useSettingsCatalog();
	const { workspace } = useWorkspace();
	// Observers lack project:update: they see every page read-only, as before.
	const readOnly = !workspace || isReadOnlyRole(workspace.role);
	const query = useMemo(
		() => ({
			deep: { tags: { _sort: "sort" } },
			fields: [...PORTAL_PROJECT_FIELDS] as never,
		}),
		[],
	);
	const projectQuery = useProjectById({ projectId: projectId ?? "", query });
	const wantsTopics = section === "verify";
	const topicsQuery = useVerificationTopicsQuery(
		wantsTopics ? projectId : undefined,
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a stable project per id and save, as the one-page editor kept it
	const project = useMemo(
		() => projectQuery.data,
		[projectQuery.data?.id, projectQuery.data?.updated_at],
	);

	if (!isSectionKey(section)) return <Navigate to="../welcome" replace />;

	const loading =
		!ready || projectQuery.isLoading || (wantsTopics && topicsQuery.isLoading);
	const error = projectQuery.error ?? (wantsTopics ? topicsQuery.error : null);

	return (
		<PageContainer width="full">
			<Stack gap="xl">
				{loading && <BeautifulLoading />}
				{error && (
					<ErrorNotice error={error} title={t`Error loading project`} />
				)}
				{!loading && project && (!wantsTopics || topicsQuery.data) && (
					<PortalSectionEditor
						key={section}
						project={project}
						section={section}
						option={option}
						readOnly={readOnly}
						tags={(projectQuery.data?.tags ?? []) as ProjectTag[]}
						verificationTopics={topicsQuery.data}
						isVerificationTopicsLoading={topicsQuery.isLoading}
					/>
				)}
			</Stack>
		</PageContainer>
	);
};
