import { t } from "@lingui/core/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import {
	type InheritedLegalBasis,
	LegalBasisCard,
	type LegalBasisValue,
} from "@/components/settings/LegalBasisCard";
import { API_BASE_URL } from "@/config";

async function updateWorkspaceLegalBasis(
	workspaceId: string,
	payload: {
		legal_basis: LegalBasisValue | null;
		privacy_policy_url: string | null;
	},
) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/settings`,
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
				: "Failed to update legal basis",
		);
	}
}

/** Workspace default; projects without their own override follow it. */
export const WorkspaceLegalBasisSection = ({
	settings,
	workspaceId,
	canEdit,
	isDembraneUser,
}: {
	settings: {
		legal_basis: string | null;
		privacy_policy_url: string | null;
	};
	workspaceId: string;
	canEdit: boolean;
	isDembraneUser: boolean;
}) => {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: (payload: {
			legal_basis: LegalBasisValue | null;
			privacy_policy_url: string | null;
		}) => updateWorkspaceLegalBasis(workspaceId, payload),
		onError: (err: Error) => {
			toast.error(err.message || t`Failed to update legal basis`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Legal basis saved`);
		},
	});

	const inherited: InheritedLegalBasis = {
		label: t`System default`,
		legalBasis: "client-managed",
		privacyPolicyUrl: null,
	};

	return (
		<LegalBasisCard
			storedLegalBasis={(settings.legal_basis as LegalBasisValue) ?? null}
			storedPrivacyPolicyUrl={settings.privacy_policy_url}
			inherited={inherited}
			canEdit={canEdit}
			showDembraneOption={isDembraneUser}
			isSaving={mutation.isPending}
			onSave={(payload) => mutation.mutate(payload)}
			readOnlyNote={t`Only workspace admins can change the legal basis.`}
		/>
	);
};
