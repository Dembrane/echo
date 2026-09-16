import { t } from "@lingui/core/macro";
import { useDocumentTitle } from "@mantine/hooks";
import { useParams, useSearchParams } from "react-router";
import { parseFixture } from "@/components/map/data/fixture";
import { MapPage } from "@/components/map/MapPage";
import { ENABLE_MAP_FIXTURES } from "@/config";

export const MapRoute = () => {
	const { projectId, workspaceId } = useParams<{
		projectId: string;
		workspaceId: string;
	}>();
	const [searchParams] = useSearchParams();
	useDocumentTitle(t`Map | dembrane`);

	if (!projectId) return null;

	const fixture = ENABLE_MAP_FIXTURES
		? parseFixture(searchParams.get("fixture"))
		: null;

	return (
		<MapPage
			projectId={projectId}
			workspaceId={workspaceId}
			fixture={fixture}
		/>
	);
};
