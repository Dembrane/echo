import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Center, Loader, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

interface V2ProjectDetail {
	id: string;
	name: string | null;
	workspace_id: string | null;
	visibility: "workspace" | "private";
	role: string;
	source: string;
	language: string | null;
	updated_at: string | null;
}

async function fetchProjectDetail(
	projectId: string,
): Promise<{ ok: true; data: V2ProjectDetail } | { ok: false; status: number }> {
	const res = await fetch(`${API_BASE_URL}/v2/projects/${projectId}`, {
		credentials: "include",
	});
	if (!res.ok) return { ok: false, status: res.status };
	return { ok: true, data: await res.json() };
}

/**
 * Guards project detail routes against users who don't have access.
 *
 * Wraps the project detail tree with an upfront v2 access check. If the
 * backend returns 404 (which it does both for deleted projects AND for
 * private projects the caller isn't shared on — the endpoint deliberately
 * doesn't distinguish), renders the designer-approved copy.
 *
 * Note: conversations / chats / reports of a private project are
 * currently reachable via the Directus SDK paths (which don't know about
 * visibility). A Directus-permissions update is the proper fix — tracked
 * as an open follow-up. This guard covers the URL-pasting case at the
 * project-detail entry, which is where most unauthorized access lands.
 */
export const ProjectAccessGuard = ({ children }: { children: ReactNode }) => {
	const { projectId } = useParams();
	const navigate = useI18nNavigate();

	const { data, isLoading } = useQuery({
		queryKey: ["v2", "project-detail", projectId],
		queryFn: () => fetchProjectDetail(projectId as string),
		enabled: Boolean(projectId),
		staleTime: 30_000,
		retry: false,
	});

	if (!projectId) return <>{children}</>;

	if (isLoading) {
		return (
			<Center style={{ height: "60vh" }}>
				<Loader size="sm" color="gray" />
			</Center>
		);
	}

	if (data && data.ok) {
		return <>{children}</>;
	}

	// 404 or other error — render the designer's copy. We don't distinguish
	// "deleted" from "private-and-not-shared" here; the endpoint's 404 is
	// deliberately ambiguous for security.
	return (
		<Center style={{ height: "60vh" }}>
			<Stack align="center" gap="md" maw={420} px="lg">
				<Title order={3} fw={400} ta="center">
					<Trans>This isn't available to you</Trans>
				</Title>
				<Text size="sm" c="dimmed" ta="center" lh={1.6}>
					<Trans>
						The link may be private, or it may have moved. Ask the person who
						shared it to check.
					</Trans>
				</Text>
				<Button variant="default" size="sm" onClick={() => navigate("/")}>
					<Trans>Go home</Trans>
				</Button>
			</Stack>
		</Center>
	);
};
