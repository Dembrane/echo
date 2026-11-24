import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Divider, Select } from "@mantine/core";
import { useState } from "react";
import {
	type AiProvider,
	providerLabel,
	useProjectAiProviderQuery,
	useSetProjectAiProviderMutation,
} from "@/components/ai-models/hooks";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { testId } from "@/lib/testUtils";
import { ProjectSettingsSection } from "../ProjectSettingsSection";

/**
 * Which AI models this project uses, among the ones its account allows. Shown to project
 * admins when the account allows more than one; an account with one never sees it.
 */
export const ProjectAiModels = ({ projectId }: { projectId: string }) => {
	const { data } = useProjectAiProviderQuery(projectId);
	const save = useSetProjectAiProviderMutation(projectId);
	const [pending, setPending] = useState<AiProvider | null>(null);
	if (!data || data.options.length < 2 || !data.can_change) return null;

	const optionLabel = (p: AiProvider) =>
		p === data.account_default
			? t`${providerLabel(p)} (account default)`
			: providerLabel(p);
	const choose = (value: string | null) => {
		if (!value || value === data.effective) return;
		const provider = value as AiProvider;
		// Google asks once; going back to the default provider asks nothing.
		if (provider === "google") setPending(provider);
		else save.mutate(provider === data.account_default ? null : provider);
	};

	return (
		<>
			<Divider />
			<ProjectSettingsSection
				title={<Trans>AI models</Trans>}
				align="start"
				{...testId("project-ai-models-section")}
			>
				<Select
					aria-label={t`AI models`}
					maw="320px"
					w="100%"
					allowDeselect={false}
					data={data.options.map((p) => ({ label: optionLabel(p), value: p }))}
					value={data.effective}
					disabled={save.isPending}
					onChange={choose}
					{...testId("project-ai-models-select")}
				/>
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
					data-testid="project-ai-models-modal"
				/>
			</ProjectSettingsSection>
		</>
	);
};
