import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { API_BASE_URL } from "@/config";
import { toast } from "../common/Toaster";

type LegalBasisValue = "client-managed" | "consent" | "dembrane-events";

interface LegalBasisSettingsCardProps {
	workspaceId: string;
	currentLegalBasis: LegalBasisValue;
	currentPrivacyUrl: string;
	canEdit: boolean;
}

export const LegalBasisSettingsCard: React.FC<LegalBasisSettingsCardProps> = ({
	workspaceId,
	currentLegalBasis,
	currentPrivacyUrl,
	canEdit,
}) => {
	const { data: user } = useCurrentUser();
	const queryClient = useQueryClient();

	const userEmail = user?.email ?? "";
	const isDembraneUser = userEmail.endsWith("@dembrane.com");

	const [legalBasis, setLegalBasis] =
		useState<LegalBasisValue>(currentLegalBasis);
	const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState(currentPrivacyUrl);

	useEffect(() => {
		setLegalBasis(currentLegalBasis);
		setPrivacyPolicyUrl(currentPrivacyUrl);
	}, [currentLegalBasis, currentPrivacyUrl]);

	const hasChanges =
		legalBasis !== currentLegalBasis ||
		privacyPolicyUrl !== currentPrivacyUrl;

	const saveDisabled =
		!hasChanges ||
		!canEdit ||
		(legalBasis === "consent" && !privacyPolicyUrl.trim());

	const mutation = useMutation({
		mutationFn: async () => {
			const response = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/settings`,
				{
					body: JSON.stringify({
						legal_basis: legalBasis,
						privacy_policy_url:
							legalBasis === "consent" ? privacyPolicyUrl.trim() || null : null,
					}),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PATCH",
				},
			);

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.detail || "Failed to update legal basis");
			}
		},
		onError: (error: Error) => {
			toast.error(error.message || t`Failed to update legal basis`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "workspace-settings", workspaceId],
			});
			toast.success(t`Legal basis updated`);
		},
	});

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<IconScale size={24} stroke={1.5} />
					<Title order={3}>
						<Trans>Legal Basis</Trans>
					</Title>
				</Group>

				<Text size="sm" c="dimmed">
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
						<Trans>
							Only change this setting in consultation with the responsible
							person(s) for data protection within your organisation.
						</Trans>
					</Text>
				</Alert>

				{!canEdit && (
					<Alert variant="light" color="primary" title={t`Read-only`}>
						<Text size="sm">
							<Trans>
								These settings are read-only. Only organisation administrators can modify project defaults.
							</Trans>
						</Text>
					</Alert>
				)}

				<Radio.Group
					value={legalBasis}
					onChange={(value) => setLegalBasis(value as LegalBasisValue)}
				>
					<Stack gap="xs">
						<Radio
							value="client-managed"
							label={t`Client-managed`}
							disabled={!canEdit}
						/>
						<Radio
							value="consent"
							label={t`Consent`}
							disabled={!canEdit}
						/>
						{isDembraneUser && (
							<Radio
								value="dembrane-events"
								label={t`dembrane events`}
								disabled={!canEdit}
							/>
						)}
					</Stack>
				</Radio.Group>

				{legalBasis === "consent" && (
					<TextInput
						label={t`Organiser's Privacy Policy URL`}
						disabled={!canEdit}
						description={t`Link to your organisation's privacy policy that will be shown to participants`}
						placeholder="https://example.com/privacy-policy"
						value={privacyPolicyUrl}
						onChange={(e) => setPrivacyPolicyUrl(e.currentTarget.value)}
						required
					/>
				)}

				<Group>
					<Button
						onClick={() => mutation.mutate()}
						loading={mutation.isPending}
						disabled={saveDisabled}
					>
						<Trans>Save</Trans>
					</Button>
				</Group>
			</Stack>
		</Card>
	);
};
