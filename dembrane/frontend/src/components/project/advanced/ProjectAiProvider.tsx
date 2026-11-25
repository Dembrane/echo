import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Divider, VisuallyHidden } from "@mantine/core";
import { useState } from "react";
import {
	type AiProvider,
	useProjectAiProviderQuery,
	useSetProjectAiProviderMutation,
} from "@/components/ai-provider/hooks";
import { ProviderCard } from "@/components/ai-provider/ProviderCard";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { SelectableCardGrid } from "@/components/common/SelectableCardGrid/SelectableCardGrid";
import { ProjectSettingsSection } from "../ProjectSettingsSection";

/**
 * Which AI provider this project uses, among the ones its account allows. Shown to project
 * admins when the account allows more than one; an account with one never sees it.
 */
export const ProjectAiProvider = ({ projectId }: { projectId: string }) => {
	const { data } = useProjectAiProviderQuery(projectId);
	const save = useSetProjectAiProviderMutation(projectId);
	const [pending, setPending] = useState<AiProvider | null>(null);
	if (!data || data.options.length < 2 || !data.can_change) return null;

	const choose = (value: string) => {
		if (value === data.effective) return;
		const provider = value as AiProvider;
		// Google asks once; going back to the default provider asks nothing.
		if (provider === "google") setPending(provider);
		else save.mutate(provider === data.account_default ? null : provider);
	};

	return (
		<>
			<Divider />
			<ProjectSettingsSection
				title={<Trans>AI provider</Trans>}
				align="start"
				id="project-ai-provider-section"
			>
				<Box w="100%" maw={880}>
					<VisuallyHidden id="project-ai-provider-label">
						<Trans>AI provider</Trans>
					</VisuallyHidden>
					<SelectableCardGrid
						name="project-ai-provider"
						labelId="project-ai-provider-label"
						value={data.effective}
						onChange={choose}
						testId="project-ai-provider-choice"
						options={data.options.map((p) => ({
							render: (checked) => (
								<ProviderCard
									provider={p}
									models={data.models?.[p]}
									selected={checked}
									flush
									badge={
										p === data.account_default ? (
											<Trans>Account default</Trans>
										) : undefined
									}
								/>
							),
							testId: `project-provider-${p}`,
							value: p,
						}))}
					/>
				</Box>
				<ConfirmModal
					opened={pending !== null}
					onClose={() => setPending(null)}
					title={t`Use Google Vertex AI for this project?`}
					message={
						<Trans>
							New conversations and all analysis in this project go to Google in
							the EU, billed per use.
						</Trans>
					}
					confirmLabel={<Trans>Use Google</Trans>}
					loading={save.isPending}
					onConfirm={() =>
						pending &&
						save.mutate(pending === data.account_default ? null : pending, {
							onSettled: () => setPending(null),
						})
					}
					data-testid="project-ai-provider-modal"
				/>
			</ProjectSettingsSection>
		</>
	);
};
