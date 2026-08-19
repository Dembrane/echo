import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	Radio,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { IconAlertTriangle, IconScale } from "@tabler/icons-react";
import { useEffect, useState } from "react";

export type LegalBasisValue = "client-managed" | "consent" | "dembrane-events";

export const LEGAL_BASIS_LABELS: Record<LegalBasisValue, () => string> = {
	"client-managed": () => t`Client-managed`,
	consent: () => t`Consent`,
	"dembrane-events": () => t`dembrane events`,
};

// Keep in sync with server/dembrane/legal_basis.py (scheme + varchar 255 cap)
export const isValidPrivacyPolicyUrl = (value: string): boolean => {
	const cleaned = value.trim();
	return (
		cleaned.length > 0 && cleaned.length <= 255 && /^https?:\/\//i.test(cleaned)
	);
};

export type InheritedLegalBasis = {
	legalBasis: LegalBasisValue;
	privacyPolicyUrl: string | null;
	// badge text, e.g. t`System default`
	label: string;
};

/**
 * Legal-basis editor shared by the workspace card and the project override.
 * Consent can never be saved without a valid privacy policy URL.
 */
export const LegalBasisCard = ({
	storedLegalBasis,
	storedPrivacyPolicyUrl,
	inherited,
	canEdit,
	showDembraneOption,
	isSaving,
	onSave,
	onClear,
	clearLabel,
	readOnlyNote,
}: {
	// null = this level inherits
	storedLegalBasis: LegalBasisValue | null;
	storedPrivacyPolicyUrl: string | null;
	// what applies while this level holds no value
	inherited?: InheritedLegalBasis | null;
	canEdit: boolean;
	showDembraneOption: boolean;
	isSaving: boolean;
	onSave: (payload: {
		legal_basis: LegalBasisValue;
		privacy_policy_url: string | null;
	}) => void;
	// clears this level back to inheriting; button renders only when set
	onClear?: () => void;
	clearLabel?: string;
	readOnlyNote?: string;
}) => {
	// Prefill from the inherited value so the effective state is visible and
	// an inherited consent URL doesn't need retyping.
	const baselineBasis = storedLegalBasis ?? inherited?.legalBasis ?? null;
	const baselineUrl =
		storedPrivacyPolicyUrl ?? inherited?.privacyPolicyUrl ?? "";
	const [legalBasis, setLegalBasis] = useState<LegalBasisValue | null>(
		baselineBasis,
	);
	const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState(baselineUrl);
	const [urlTouched, setUrlTouched] = useState(false);

	useEffect(() => {
		setLegalBasis(baselineBasis);
		setPrivacyPolicyUrl(baselineUrl);
		setUrlTouched(false);
	}, [baselineBasis, baselineUrl]);

	const consentSelected = legalBasis === "consent";
	const urlValid = isValidPrivacyPolicyUrl(privacyPolicyUrl);
	const urlError =
		consentSelected && (urlTouched || privacyPolicyUrl.length > 0) && !urlValid
			? t`A privacy policy link is required for consent-based processing. It must start with http:// or https:// and be at most 255 characters.`
			: undefined;

	// Dirty against the displayed baseline, not the stored value: a pristine
	// card never silently pins the inherited value at this level.
	const hasChanges =
		legalBasis !== baselineBasis ||
		(consentSelected && privacyPolicyUrl !== baselineUrl);

	const canSave =
		canEdit &&
		legalBasis !== null &&
		hasChanges &&
		(!consentSelected || urlValid);

	// Legacy prod rows saved before validation existed
	const storedStateInvalid =
		storedLegalBasis === "consent" && !storedPrivacyPolicyUrl;

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<IconScale size={24} stroke={1.5} />
					<Title order={4}>
						<Trans>Legal Basis</Trans>
					</Title>
				</Group>

				<Text size="sm">
					<Trans>
						Determines under which GDPR legal basis personal data is processed.
						This affects the information shown to participants and data subject
						rights.
					</Trans>
				</Text>

				<Alert
					variant="light"
					color="yellow"
					icon={<IconAlertTriangle size={16} />}
				>
					<Text size="sm">
						{storedStateInvalid ? (
							<Trans>
								This is set to consent-based processing without a privacy policy
								link. Add one to keep this setting valid: participants must be
								able to read the privacy policy.
							</Trans>
						) : !canEdit && readOnlyNote ? (
							readOnlyNote
						) : (
							<Trans>
								Only change this setting in consultation with the responsible
								person(s) for data protection within your organisation.
							</Trans>
						)}
					</Text>
				</Alert>

				<Radio.Group
					value={legalBasis ?? ""}
					onChange={(value) => {
						setLegalBasis(value as LegalBasisValue);
					}}
				>
					<Stack gap="xs">
						{(
							[
								"client-managed",
								"consent",
								"dembrane-events",
							] as LegalBasisValue[]
						)
							.filter(
								(value) =>
									value !== "dembrane-events" ||
									showDembraneOption ||
									legalBasis === "dembrane-events",
							)
							.map((value) => {
								const showInheritedBadge =
									storedLegalBasis === null && inherited?.legalBasis === value;
								return (
									<Radio
										key={value}
										value={value}
										label={
											showInheritedBadge ? (
												<Group gap="xs" wrap="nowrap">
													{LEGAL_BASIS_LABELS[value]()}
													<Badge size="sm" variant="light" ml="xs">
														{inherited.label}
													</Badge>
												</Group>
											) : (
												LEGAL_BASIS_LABELS[value]()
											)
										}
										disabled={
											!canEdit ||
											(value === "dembrane-events" && !showDembraneOption)
										}
									/>
								);
							})}
					</Stack>
				</Radio.Group>

				{consentSelected && (
					<TextInput
						label={t`Privacy Policy URL`}
						withAsterisk
						disabled={!canEdit}
						description={t`Link to the privacy policy shown to participants`}
						placeholder="https://example.com/privacy-policy"
						value={privacyPolicyUrl}
						error={urlError}
						onChange={(e) => setPrivacyPolicyUrl(e.currentTarget.value)}
						onBlur={() => setUrlTouched(true)}
					/>
				)}

				<Group>
					<Button
						onClick={() => {
							if (!legalBasis) return;
							onSave({
								legal_basis: legalBasis,
								privacy_policy_url: consentSelected
									? privacyPolicyUrl.trim()
									: null,
							});
						}}
						loading={isSaving}
						disabled={!canSave}
					>
						<Trans>Save</Trans>
					</Button>
					{onClear && storedLegalBasis !== null && (
						<Button
							variant="subtle"
							disabled={!canEdit || isSaving}
							onClick={onClear}
						>
							{clearLabel ?? t`Use inherited default`}
						</Button>
					)}
				</Group>
			</Stack>
		</Card>
	);
};
