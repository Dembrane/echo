import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Stack, Switch, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Controller } from "react-hook-form";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { FormLabel } from "@/components/form/FormLabel";
import {
	ProjectLegalBasisSection,
	useProjectLegalQuery,
} from "@/components/project/ProjectLegalBasisSection";
import { LEGAL_BASIS_LABELS } from "@/components/settings/LegalBasisCard";
import { testId } from "@/lib/testUtils";
import type { PortalFormValues } from "../portalForm";
import { AnonymiseExample } from "./AnonymiseExample";
import { onOff, type SectionContent, type SectionProps } from "./types";

/** Privacy: the legal basis (saved on its own, as before) and anonymised transcripts. */
export const usePrivacyOptions = ({
	project,
	page,
}: SectionProps): SectionContent => {
	const { control, formState, setValue, getValues } = page.form;
	const legal = useProjectLegalQuery(project.id);
	const [modalOpened, modal] = useDisclosure(false);
	const basis = legal.data?._legal?.effective?.legal_basis;
	return {
		extra: (
			<ConfirmModal
				opened={modalOpened}
				onClose={modal.close}
				title={t`Turn off anonymization?`}
				message={
					<Trans id="portal.anonymization.disable.warning">
						Turning off anonymization while recordings are ongoing may have
						unintended consequences. Active conversations will also be affected
						mid-recording. Please use this with caution.
					</Trans>
				}
				confirmLabel={
					<Trans id="portal.anonymization.disable.confirm">Turn off</Trans>
				}
				confirmColor="red"
				onConfirm={() => {
					setValue("anonymize_transcripts", false, { shouldDirty: true });
					modal.close();
					page.saveNow({
						...getValues(),
						anonymize_transcripts: false,
					} as PortalFormValues);
				}}
				data-testid="anonymize-disable-modal"
			/>
		),
		options: {
			anonymise: {
				beta: true,
				body: (
					<Stack gap="md">
						<Text size="sm" c="dimmed">
							<Trans>
								When enabled, all new transcripts will have personal information
								(names, emails, phone numbers, addresses) replaced with
								placeholders. Anonymized conversations also disable audio
								playback, audio download, and retranscription to protect
								participant privacy. This cannot be undone for already-processed
								conversations.
							</Trans>
						</Text>
						<Controller
							name="anonymize_transcripts"
							control={control}
							render={({ field }) => (
								<Switch
									label={
										<FormLabel
											label={t`Enable transcript anonymization`}
											isDirty={formState.dirtyFields.anonymize_transcripts}
											error={formState.errors.anonymize_transcripts?.message}
										/>
									}
									checked={field.value}
									onChange={(e) => {
										const next = e.currentTarget.checked;
										// Turning it off asks first.
										if (!next && field.value) modal.open();
										else field.onChange(next);
									}}
									{...testId("portal-editor-anonymize-switch")}
								/>
							)}
						/>
						<AnonymiseExample />
					</Stack>
				),
				summary: onOff(page.values.anonymize_transcripts, t`On`, t`Off`),
				title: t`Anonymize transcripts`,
			},
			"legal-basis": {
				body: <ProjectLegalBasisSection projectId={project.id} />,
				summary: basis ? LEGAL_BASIS_LABELS[basis]() : "",
				title: t`Legal basis`,
			},
		},
	};
};
