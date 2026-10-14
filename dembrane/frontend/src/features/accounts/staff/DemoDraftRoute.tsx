import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Anchor, Box, Group, Loader, Stack, Text } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { API_BASE_URL } from "@/config";
import { call } from "../api/client";
import { AccountsI18n } from "../i18n";
import { StaffOnly } from "./AccountCardRoute";
import { demoKey } from "./DemoRoute";

/**
 * Staff: a demo's deck as the room will see it, before it is public. The API serves the
 * deck for the demo's own session only; this page frames it under one line that says
 * what it is, so nobody takes a draft for the live page.
 */
export const DemoDraftRoute = () => (
	<AccountsI18n>
		<StaffOnly>
			<DemoDraft />
		</StaffOnly>
	</AccountsI18n>
);

const deckUrl = (demoId: string, language: string) =>
	`${API_BASE_URL}/v2/admin/accounts/demos/${encodeURIComponent(demoId)}/deck/${encodeURIComponent(language)}/`;

function DemoDraft() {
	const { demoId, deckLanguage } = useParams<{
		demoId: string;
		deckLanguage: string;
	}>();
	const { data: demo, isLoading } = useQuery({
		enabled: Boolean(demoId),
		queryFn: () => call("demoStatus", { params: { demoId: demoId as string } }),
		queryKey: demoKey(demoId ?? ""),
	});
	useDocumentTitle(
		demo ? `${demo.organisation_name} | ${t`Demo`}` : t`Demo | dembrane`,
	);
	if (isLoading || !demo || !demoId || !deckLanguage)
		return <Loader m="xl" size="sm" />;
	const ready = demo.status === "draft" || demo.status === "published";

	return (
		<Stack gap={0} h="100%" data-testid="demo-draft-screen">
			<Group
				justify="space-between"
				wrap="nowrap"
				px={{ base: "md", sm: "lg" }}
				py="sm"
				style={{
					borderBottom: "1px solid var(--app-quiet)",
					borderTop: "1px solid var(--app-quiet)",
				}}
				data-testid="demo-draft-bar"
			>
				<Text size="sm">
					{demo.status === "published" ? (
						<Trans>
							{demo.organisation_name}: this demo is public. This is what the
							public link shows.
						</Trans>
					) : (
						<Trans>
							{demo.organisation_name}: this is a draft. It is not public yet.
						</Trans>
					)}
				</Text>
				<Anchor
					component={I18nLink}
					to={`/admin/accounts/demos/${demoId}`}
					size="sm"
					style={{ whiteSpace: "nowrap" }}
				>
					<Group gap={4} wrap="nowrap">
						<ArrowLeftIcon size={16} />
						<Trans>Back to the demo</Trans>
					</Group>
				</Anchor>
			</Group>
			{ready ? (
				<Box
					component="iframe"
					src={deckUrl(demoId, deckLanguage)}
					title={t`Demo draft`}
					style={{ border: 0, flex: 1, minHeight: 420, width: "100%" }}
					data-testid="demo-draft-deck"
				/>
			) : (
				<Text size="sm" c="dimmed" p="lg">
					<Trans>The draft is not ready yet.</Trans>
				</Text>
			)}
		</Stack>
	);
}
