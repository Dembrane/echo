import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Group,
	Radio,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";

type UsageContext = "internal" | "external";

async function updateDataOwnership(
	workspaceId: string,
	payload: {
		usage_context: UsageContext;
		data_owner_org_name?: string;
		data_owner_email?: string;
		partner_agreement_accepted?: boolean;
	},
) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/data-ownership`,
		{
			body: JSON.stringify(payload),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: "Failed to update data ownership",
		);
	}
}

/**
 * Admin-only editor for a workspace's data ownership: its internal/external
 * classification and the owning organisation + data-owner contact. Flipping the
 * classification re-scopes billing on the server, so the label and the billing /
 * data-ownership context stay consistent.
 */
export const WorkspaceDataOwnershipSection = ({
	settings,
	workspaceId,
	canEdit,
}: {
	settings: {
		is_external_client: boolean;
		data_owner_org_name: string | null;
		data_owner_email: string | null;
	};
	workspaceId: string;
	canEdit: boolean;
}) => {
	const queryClient = useQueryClient();

	const initialUsage: UsageContext = settings.is_external_client
		? "external"
		: "internal";
	const [usage, setUsage] = useState<UsageContext>(initialUsage);
	const [orgName, setOrgName] = useState(settings.data_owner_org_name ?? "");
	const [email, setEmail] = useState(settings.data_owner_email ?? "");

	// Going internal→external for the first time carries the (implicit) partner
	// agreement; an already external workspace already accepted it.
	const goingExternalFresh =
		usage === "external" && !settings.is_external_client;
	const emailValid = /.+@.+\..+/.test(email.trim());
	const orgValid = orgName.trim().length > 0;

	const dirty =
		usage !== initialUsage ||
		orgName.trim() !== (settings.data_owner_org_name ?? "").trim() ||
		email.trim().toLowerCase() !==
			(settings.data_owner_email ?? "").trim().toLowerCase();

	const canSubmit =
		canEdit && dirty && (usage === "internal" || (orgValid && emailValid));

	const mutation = useMutation({
		mutationFn: () =>
			updateDataOwnership(workspaceId, {
				data_owner_email: usage === "external" ? email.trim() : undefined,
				data_owner_org_name: usage === "external" ? orgName.trim() : undefined,
				partner_agreement_accepted: goingExternalFresh ? true : undefined,
				usage_context: usage,
			}),
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			posthog.capture("workspace_data_ownership_updated", {
				usage_context: usage,
			});
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-usage"] });
			toast.success(t`Saved`);
		},
	});

	return (
		<Stack gap={16} data-testid="workspace-data-ownership-section">
			<Stack gap={4}>
				<Text size="sm" fw={500}>
					<Trans>Data ownership</Trans>
				</Text>
				<Text size="xs">
					<Trans>
						Is this workspace for your organisation's internal use, or for an
						external organisation that owns its data?
					</Trans>
				</Text>
			</Stack>

			<Radio.Group value={usage} onChange={(v) => setUsage(v as UsageContext)}>
				<Stack gap={8}>
					<Radio
						value="internal"
						disabled={!canEdit}
						label={<Trans>For internal use</Trans>}
						data-testid="data-ownership-internal"
					/>
					<Radio
						value="external"
						disabled={!canEdit}
						label={<Trans>For an external organisation</Trans>}
						data-testid="data-ownership-external"
					/>
				</Stack>
			</Radio.Group>

			{usage === "external" && (
				<Stack gap={10}>
					<TextInput
						required
						label={<Trans>Owning organisation</Trans>}
						description={
							<Trans>
								Which organisation owns this workspace's data? This sets the
								data and compliance context.
							</Trans>
						}
						placeholder="Acme Organisation"
						value={orgName}
						onChange={(e) => setOrgName(e.currentTarget.value)}
						disabled={!canEdit}
						data-testid="data-ownership-org"
					/>
					<TextInput
						type="email"
						required
						label={<Trans>Data owner email</Trans>}
						description={
							<Trans>
								Their representative who owns this data. They are added as a
								free observer and become the handoff contact.
							</Trans>
						}
						placeholder="jane.doe@acme.org"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						disabled={!canEdit}
						data-testid="data-ownership-email"
					/>
				</Stack>
			)}

			{usage !== initialUsage && (
				<Alert color="primary" variant="light">
					{usage === "external" ? (
						<Trans>
							This moves the workspace into its own billing and data context.
							Its projects will no longer move freely with the rest of your
							organisation.
						</Trans>
					) : (
						<Trans>
							This returns the workspace to your organisation's shared billing
							and removes its external data owner.
						</Trans>
					)}
				</Alert>
			)}

			<Group justify="flex-end">
				<Button
					onClick={() => mutation.mutate()}
					loading={mutation.isPending}
					disabled={!canSubmit}
					data-testid="data-ownership-save"
				>
					<Trans>Save</Trans>
				</Button>
			</Group>
		</Stack>
	);
};
