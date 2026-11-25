import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Box, Divider, Group, Stack, Title } from "@mantine/core";
import { type ReactNode, useState } from "react";
import {
	type AiJob,
	type AiProvider,
	costText,
	euros,
	jobName,
	type ProjectAiProviders,
	useProjectAiProviderQuery,
	useSetProjectAiProviderMutation,
} from "@/components/ai-provider/hooks";
import { ProviderCard } from "@/components/ai-provider/ProviderCard";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { SelectableCardGrid } from "@/components/common/SelectableCardGrid/SelectableCardGrid";
import { ProjectSettingsSection } from "../ProjectSettingsSection";

/** The jobs of a project that have a real choice: the account enabled more than one provider. */
export const choosableJobs = (data: ProjectAiProviders): AiJob[] =>
	(["transcription", "analysis"] as const).filter(
		(job) => data.jobs[job].options.length > 1,
	);

/**
 * Which AI provider this project uses for each job, among the ones its account has enabled for
 * it. Shown to project admins for a job with more than one choice; an account with one never
 * sees it. `explainers` leaves a place next to each job's title.
 */
export const ProjectAiProvider = ({
	projectId,
	explainers,
}: {
	projectId: string;
	explainers?: Partial<Record<AiJob, ReactNode>>;
}) => {
	const { i18n } = useLingui();
	const { data } = useProjectAiProviderQuery(projectId);
	const save = useSetProjectAiProviderMutation(projectId);
	const [pending, setPending] = useState<{
		job: AiJob;
		provider: AiProvider;
	} | null>(null);
	if (!data || !data.can_change) return null;
	const jobs = choosableJobs(data);
	if (jobs.length === 0) return null;

	const choose = (job: AiJob, value: string) => {
		const choice = data.jobs[job];
		if (value === choice.effective) return;
		const provider = value as AiProvider;
		// Google asks once; going back to the account default asks nothing.
		if (provider === "google") setPending({ job, provider });
		else
			save.mutate({
				job,
				provider: provider === choice.account_default ? null : provider,
			});
	};

	const asking = pending ? jobName(pending.job) : "";
	const monthly = pending ? data.cost[pending.job].google?.monthly_eur : null;
	const amount =
		monthly !== null && monthly !== undefined
			? euros(monthly, i18n.locale, "estimate")
			: null;

	return (
		<>
			<Divider />
			<ProjectSettingsSection
				title={<Trans>AI provider</Trans>}
				align="start"
				id="project-ai-provider-section"
			>
				<Stack gap="xl" w="100%" maw={880}>
					{jobs.map((job) => {
						const choice = data.jobs[job];
						const labelId = `project-ai-provider-${job}-label`;
						return (
							<Stack key={job} gap="sm" data-testid={`project-job-${job}`}>
								<Group gap="xs" align="center">
									<Title order={5} id={labelId}>
										{jobName(job)}
									</Title>
									{explainers?.[job]}
								</Group>
								<Box w="100%">
									<SelectableCardGrid
										name={`project-ai-provider-${job}`}
										labelId={labelId}
										value={choice.effective}
										onChange={(v) => choose(job, v)}
										testId={`project-ai-provider-choice-${job}`}
										options={choice.options.map((p) => ({
											render: (checked) => (
												<ProviderCard
													provider={p}
													models={data.models?.[p]?.[job]}
													selected={checked}
													flush
													cost={costText(data.cost[job][p], i18n.locale)}
													badge={
														p === choice.account_default ? (
															<Trans>Account default</Trans>
														) : undefined
													}
												/>
											),
											testId: `project-provider-${job}-${p}`,
											value: p,
										}))}
									/>
								</Box>
							</Stack>
						);
					})}
				</Stack>
				<ConfirmModal
					opened={pending !== null}
					onClose={() => setPending(null)}
					title={t`Use Google Vertex AI for ${asking}?`}
					message={
						amount !== null ? (
							<Trans>
								{asking} in this project goes to Google in the EU, billed on top
								of your plan, about {amount} a month at your last 30 days of
								use.
							</Trans>
						) : (
							<Trans>
								{asking} in this project goes to Google in the EU, billed on top
								of your plan.
							</Trans>
						)
					}
					confirmLabel={<Trans>Use Google</Trans>}
					loading={save.isPending}
					onConfirm={() =>
						pending &&
						save.mutate(
							{
								job: pending.job,
								provider:
									pending.provider === data.jobs[pending.job].account_default
										? null
										: pending.provider,
							},
							{ onSettled: () => setPending(null) },
						)
					}
					data-testid="project-ai-provider-modal"
				/>
			</ProjectSettingsSection>
		</>
	);
};
