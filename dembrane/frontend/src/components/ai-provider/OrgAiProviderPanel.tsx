import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Box, SimpleGrid, Skeleton, Stack, Text, Title } from "@mantine/core";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import {
	type AiHistoryLine,
	formatDay,
	providerName,
	useOrgAiProvidersQuery,
} from "./hooks";
import { ProviderCard } from "./ProviderCard";

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

// Organisation settings > AI provider. Owners and admins read it; dembrane staff set it.
export const OrgAiProviderPanel = ({ orgId }: { orgId: string }) => {
	const { i18n } = useLingui();
	const { data, isLoading, error, refetch } = useOrgAiProvidersQuery(orgId);
	if (isLoading) return <Skeleton height={160} maw={880} />;
	if (error || !data)
		return (
			<FetchErrorPanel
				message={t`We couldn't load the AI provider.`}
				onRetry={() => void refetch()}
			/>
		);
	return (
		<Stack gap="lg" maw={880} data-testid="org-ai-provider">
			<Title order={4}>
				<Trans>AI provider</Trans>
			</Title>
			<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
				{data.available.map((p) => {
					const has = data.allowed.includes(p);
					return (
						<Box key={p} data-testid={`org-provider-${p}`}>
							<ProviderCard
								provider={p}
								models={data.models?.[p]}
								muted={!has}
								badge={
									!has ? (
										<Trans>Not enabled</Trans>
									) : p === data.default ? (
										<Trans>Default</Trans>
									) : (
										<Trans>Enabled</Trans>
									)
								}
							/>
						</Box>
					);
				})}
			</SimpleGrid>
			{data.history.length > 0 && (
				<Stack gap={4} data-testid="ai-provider-history">
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
		</Stack>
	);
};
