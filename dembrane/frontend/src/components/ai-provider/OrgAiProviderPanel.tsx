import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Group,
	Paper,
	SimpleGrid,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { type ReactNode, useState } from "react";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { notifyError } from "@/components/error/notifyError";
import { useAccountsMutation } from "@/features/accounts/api/hooks";
import {
	type AiHistoryLine,
	type AiJob,
	type AiProvider,
	costText,
	euros,
	formatDay,
	jobName,
	providerName,
	useOrgAiProvidersQuery,
} from "./hooks";
import { ProviderCard } from "./ProviderCard";

/** "Google Vertex AI enabled for Analysis": one line of the change log. */
export const historyText = (line: AiHistoryLine): string => {
	const provider = providerName(line.provider);
	const job = jobName(line.job);
	if (line.kind === "enabled") return t`${provider} enabled for ${job}`;
	if (line.kind === "disabled") return t`${provider} removed from ${job}`;
	return t`${provider} is now the default for ${job}`;
};

/** What the Request button writes to the account's ticket list. */
export const requestTicket = (provider: AiProvider, job: AiJob) => {
	const name = providerName(provider);
	const what = jobName(job);
	return {
		body: t`Please enable ${name} for ${what} on our account.`,
		subject: t`${name} for ${what}`,
	};
};

/**
 * Organisation settings > AI provider. Owners and admins read it; dembrane staff set it.
 * `explainers` leaves a place next to each job's title for the explainer animation.
 */
export const OrgAiProviderPanel = ({
	orgId,
	explainers,
}: {
	orgId: string;
	explainers?: Partial<Record<AiJob, ReactNode>>;
}) => {
	const { i18n } = useLingui();
	const { data, isLoading, error, refetch } = useOrgAiProvidersQuery(orgId);
	const ticket = useAccountsMutation("openTicket", { orgId });
	// What this visit has asked for, so a second click does not open a second ticket.
	const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
	const [asking, setAsking] = useState<string | null>(null);
	if (isLoading) return <Skeleton height={160} maw={880} />;
	if (error || !data)
		return (
			<FetchErrorPanel
				message={t`We couldn't load the AI provider.`}
				onRetry={() => void refetch()}
			/>
		);

	const request = (provider: AiProvider, job: AiJob) => {
		const key = `${job}:${provider}`;
		setAsking(key);
		ticket.mutate(
			{ body: requestTicket(provider, job) },
			{
				onError: (e) => void notifyError(e),
				onSettled: () => setAsking(null),
				onSuccess: () => setAsked((s) => new Set(s).add(key)),
			},
		);
	};
	const google = euros(data.month.spent.google, i18n.locale);

	return (
		<Stack gap="xl" maw={880} data-testid="org-ai-provider">
			<Title order={4}>
				<Trans>AI provider</Trans>
			</Title>
			{data.jobs.map((job) => (
				<Stack key={job} gap="md" data-testid={`org-job-${job}`}>
					<Group gap="xs" align="center">
						<Title order={5}>{jobName(job)}</Title>
						{explainers?.[job]}
					</Group>
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
						{data.available
							.filter((p) => data.serves[p].includes(job))
							.map((p) => {
								const has = data.enabled[job].includes(p);
								const key = `${job}:${p}`;
								return (
									<Box key={p} data-testid={`org-provider-${job}-${p}`}>
										<ProviderCard
											provider={p}
											models={data.models?.[p]?.[job]}
											muted={!has}
											cost={costText(data.cost[job][p], i18n.locale)}
											badge={
												!has ? (
													<Trans>Not enabled</Trans>
												) : p === data.defaults[job] ? (
													<Trans>Default</Trans>
												) : (
													<Trans>Enabled</Trans>
												)
											}
											onRequest={() => request(p, job)}
											requested={asked.has(key)}
											requesting={asking === key}
										/>
									</Box>
								);
							})}
					</SimpleGrid>
				</Stack>
			))}
			{data.history.length > 0 && (
				<Paper withBorder radius="md" p="sm" data-testid="ai-provider-history">
					<Stack gap={8}>
						{data.history.map((line) => (
							<Text
								size="sm"
								key={`${line.at}-${line.kind}-${line.provider}-${line.job}`}
							>
								{formatDay(line.at, i18n.locale)} · {historyText(line)}
							</Text>
						))}
					</Stack>
				</Paper>
			)}
			<Text size="sm" c="dimmed" data-testid="ai-provider-month">
				<Trans>This month: Scaleway included, Google {google}</Trans>
			</Text>
		</Stack>
	);
};
