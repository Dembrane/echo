import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Button, Modal, Skeleton, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { lazy, Suspense } from "react";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import {
	type AiHistoryLine,
	formatDay,
	providerLabel,
	providerName,
	useOrgAiProvidersQuery,
} from "./hooks";

// The ask form belongs to the account's Talk to us and its own catalog; it loads when asked for.
const AskForGoogle = lazy(() =>
	import("@/features/accounts/customer/AskForGoogle").then((m) => ({
		default: m.AskForGoogle,
	})),
);

export const historyText = (line: AiHistoryLine, locale: string): string => {
	const provider = providerName(line.provider);
	const on = formatDay(line.at, locale);
	const asked = line.request_at ? formatDay(line.request_at, locale) : null;
	if (line.kind === "added")
		return asked
			? t`${provider} added by Dembrane, ${on}, at your request of ${asked}`
			: t`${provider} added by Dembrane, ${on}`;
	if (line.kind === "removed")
		return asked
			? t`${provider} removed by Dembrane, ${on}, at your request of ${asked}`
			: t`${provider} removed by Dembrane, ${on}`;
	return asked
		? t`Default changed to ${provider} by Dembrane, ${on}, at your request of ${asked}`
		: t`Default changed to ${provider} by Dembrane, ${on}`;
};

// Organisation settings > AI models. Owners and admins read it; dembrane staff set it.
export const OrgAiModelsPanel = ({
	orgId,
	orgName,
}: {
	orgId: string;
	orgName: string;
}) => {
	const { i18n } = useLingui();
	const { data, isLoading, error, refetch } = useOrgAiProvidersQuery(orgId);
	const [asking, ask] = useDisclosure(false);
	if (isLoading) return <Skeleton height={80} maw={560} />;
	if (error || !data)
		return (
			<FetchErrorPanel
				message={t`We couldn't load the AI models.`}
				onRetry={() => void refetch()}
			/>
		);
	const others = data.allowed.filter((p) => p !== data.default);
	return (
		<Stack gap="md" data-testid="org-ai-models">
			<Title order={4}>
				<Trans>AI models</Trans>
			</Title>
			<Stack gap={4}>
				<Text size="sm">
					<Trans>Default: {providerLabel(data.default)}</Trans>
				</Text>
				{others.length > 0 && (
					<Text size="sm">
						<Trans>
							Also available: {others.map(providerLabel).join(", ")}, billed per
							use
						</Trans>
					</Text>
				)}
			</Stack>
			{!data.allowed.includes("google") && (
				<div>
					<Button
						variant="light"
						onClick={ask.open}
						data-testid="ask-google-vertex"
					>
						<Trans>Ask for Google Vertex AI</Trans>
					</Button>
				</div>
			)}
			{data.history.length > 0 && (
				<Stack gap={4} data-testid="ai-models-history">
					{data.history.map((line) => (
						<Text
							size="sm"
							c="dimmed"
							key={`${line.at}-${line.kind}-${line.provider}`}
						>
							{historyText(line, i18n.locale)}
						</Text>
					))}
				</Stack>
			)}
			<Modal
				opened={asking}
				onClose={ask.close}
				title={t`Ask for Google Vertex AI`}
			>
				{asking && (
					<Suspense fallback={<Skeleton height={160} />}>
						<AskForGoogle orgId={orgId} orgName={orgName} onDone={ask.close} />
					</Suspense>
				)}
			</Modal>
		</Stack>
	);
};
