import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Button, Center, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { actionTarget } from "@/components/error/actions";
import { useErrorPresentation } from "@/components/error/useErrorPresentation";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { ApiRequestError, ensureOk } from "@/lib/errors/read";

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
): Promise<
	| { ok: true; data: V2ProjectDetail }
	| { ok: false; status: number; error: unknown }
> {
	try {
		const res = await ensureOk(
			await fetch(`${API_BASE_URL}/v2/projects/${projectId}`, {
				credentials: "include",
			}),
		);
		return { data: await res.json(), ok: true };
	} catch (error) {
		const status = error instanceof ApiRequestError ? error.status : 0;
		return { error, ok: false, status };
	}
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
	const { i18n } = useLingui();

	const { data, isLoading, refetch } = useQuery({
		enabled: Boolean(projectId),
		queryFn: () => fetchProjectDetail(projectId as string),
		queryKey: ["v2", "project-detail", projectId],
		retry: false,
		// No stale window — visibility changes or share revocations need to
		// propagate on next navigation, not up to 30s later. react-query
		// still dedupes concurrent requests during a single mount.
		staleTime: 0,
	});

	const presented = useErrorPresentation(data && !data.ok ? data.error : null);

	if (!projectId) return <>{children}</>;

	if (isLoading) {
		return <BeautifulLoading />;
	}

	if (data && data.ok) {
		return <>{children}</>;
	}

	// Distinguish 404 ("you don't have access / not found") from other
	// failure modes (500 / network error / expired session). The 404 path
	// keeps its title; the message and the button come from the error presenter.
	const status = data && !data.ok ? data.status : 0;
	const is404 = status === 404;

	const target = presented
		? actionTarget(presented, i18n, { onRetry: () => refetch() })
		: null;

	return (
		<Center style={{ height: "60vh" }}>
			<Stack
				align="center"
				gap="md"
				maw={420}
				px="lg"
				data-error-code={presented?.code ?? "none"}
			>
				<Title order={4} ta="center">
					{is404 ? (
						<Trans>This isn't available to you</Trans>
					) : (
						<Trans>Something went wrong</Trans>
					)}
				</Title>
				<Text size="sm" c="dimmed" ta="center" lh={1.6}>
					{presented?.message}
				</Text>
				{target?.href ? (
					<Button component="a" href={target.href} size="sm">
						{target.label}
					</Button>
				) : is404 || !target ? (
					<Button size="sm" onClick={() => navigate("/")}>
						<Trans>Go home</Trans>
					</Button>
				) : (
					<Button size="sm" onClick={target.onClick}>
						{target.label}
					</Button>
				)}
			</Stack>
		</Center>
	);
};
