import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Group,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconAlertTriangle,
	IconExternalLink,
	IconScale,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { useCurrentUser } from "@/components/auth/hooks";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import {
	type InheritedLegalBasis,
	LEGAL_BASIS_LABELS,
	LegalBasisCard,
	type LegalBasisValue,
} from "@/components/settings/LegalBasisCard";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

type LegalSource = "project" | "workspace" | "legacy_user" | "default";

type ProjectLegal = {
	legal_basis: LegalBasisValue | null;
	privacy_policy_url: string | null;
	_role: string;
	_legal: {
		effective: {
			legal_basis: LegalBasisValue;
			privacy_policy_url: string | null;
			source: LegalSource;
		};
		inherited: {
			legal_basis: LegalBasisValue;
			privacy_policy_url: string | null;
			source: LegalSource;
		};
		organiser_name: string | null;
	};
};

// Badge text; "Account default" = the project creator's old account setting
const badgeLabel = (source: LegalSource): string => {
	switch (source) {
		case "workspace":
			return t`Workspace default`;
		case "legacy_user":
			return t`Account default`;
		default:
			return t`System default`;
	}
};

const sourceLabel = (source: LegalSource): string => {
	switch (source) {
		case "project":
			return t`Overridden for this project`;
		case "workspace":
			return t`Workspace default`;
		case "legacy_user":
			return t`Account default`;
		default:
			return t`No default set (client-managed applies)`;
	}
};

async function fetchProjectLegal(projectId: string): Promise<ProjectLegal> {
	const url = new URL(
		`${API_BASE_URL}/v2/projects/${projectId}/bff`,
		window.location.origin,
	);
	url.searchParams.set("include_tags", "false");
	url.searchParams.set("include_legal", "true");
	url.searchParams.set("fields", "legal_basis,privacy_policy_url");
	const res = await fetch(url.toString(), { credentials: "include" });
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to load legal basis");
	}
	return res.json();
}

async function saveProjectLegal(
	projectId: string,
	payload: {
		legal_basis: LegalBasisValue | null;
		privacy_policy_url: string | null;
	},
) {
	const res = await fetch(`${API_BASE_URL}/v2/bff/projects/${projectId}`, {
		body: JSON.stringify(payload),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "PATCH",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: "Failed to update legal basis",
		);
	}
}

/**
 * Portal-editor legal basis block: effective value + source, explicit
 * override flow (deliberately outside the auto-saving portal form).
 */
export const ProjectLegalBasisSection = ({
	projectId,
}: {
	projectId: string;
}) => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser();
	const isDembraneUser = (user?.email ?? "")
		.toLowerCase()
		.endsWith("@dembrane.com");

	const [overrideFormOpen, setOverrideFormOpen] = useState(false);
	const [removeModalOpen, { open: openRemoveModal, close: closeRemoveModal }] =
		useDisclosure(false);

	const legalQuery = useQuery({
		enabled: !!projectId,
		queryFn: () => fetchProjectLegal(projectId),
		queryKey: ["projects", projectId, "legal"],
	});

	const mutation = useMutation({
		mutationFn: (payload: {
			legal_basis: LegalBasisValue | null;
			privacy_policy_url: string | null;
		}) => saveProjectLegal(projectId, payload),
		onError: (err: Error) => {
			toast.error(err.message || t`Failed to update legal basis`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
			setOverrideFormOpen(false);
			closeRemoveModal();
			toast.success(t`Legal basis saved`);
		},
	});

	const data = legalQuery.data;

	return (
		<Box>
			<Stack gap="sm">
				<Group gap="sm">
					<IconScale size={18} stroke={1.5} />
					<Text fw={600} size="sm">
						<Trans>Legal basis</Trans>
					</Text>
				</Group>
				<Text size="sm">
					<Trans>
						Determines under which GDPR legal basis personal data is processed
						for this project.
					</Trans>
				</Text>

				{data &&
					(() => {
						// admin/owner only, mirrors the server gate
						const canEditOverride = ["admin", "owner"].includes(data._role);
						const cardVisible =
							data._legal.effective.source === "project" || overrideFormOpen;
						return (
							<>
								<Paper withBorder px="md" py="sm">
									<Group justify="space-between" wrap="nowrap">
										<Text size="sm" fw={600}>
											{LEGAL_BASIS_LABELS[data._legal.effective.legal_basis]()}
										</Text>
										<Badge size="sm" variant="light">
											{sourceLabel(data._legal.effective.source)}
										</Badge>
									</Group>
								</Paper>

								{/* the card carries its own Alert; never stack two */}
								{!cardVisible &&
									data._legal.effective.legal_basis === "consent" &&
									!data._legal.effective.privacy_policy_url && (
										<Alert
											variant="light"
											color="yellow"
											icon={<IconAlertTriangle size={16} />}
										>
											<Text size="sm">
												<Trans>
													Consent-based processing is active without a privacy
													policy link. Add one where the legal basis is set:
													participants must be able to read the privacy policy.
												</Trans>
											</Text>
										</Alert>
									)}

								{cardVisible && (
									<LegalBasisCard
										storedLegalBasis={data.legal_basis}
										storedPrivacyPolicyUrl={data.privacy_policy_url}
										inherited={
											{
												label: badgeLabel(data._legal.inherited.source),
												legalBasis: data._legal.inherited.legal_basis,
												privacyPolicyUrl:
													data._legal.inherited.privacy_policy_url,
											} satisfies InheritedLegalBasis
										}
										canEdit={canEditOverride}
										showDembraneOption={isDembraneUser}
										isSaving={mutation.isPending}
										onSave={(payload) => mutation.mutate(payload)}
										onClear={
											canEditOverride && data.legal_basis !== null
												? openRemoveModal
												: undefined
										}
										clearLabel={t`Remove override`}
										readOnlyNote={t`Only workspace admins can change the legal basis.`}
									/>
								)}

								{/* admin-only: the settings link is a dead end for others */}
								{canEditOverride && (
									<Group justify="space-between" wrap="nowrap">
										{!cardVisible ? (
											<Button
												variant="outline"
												size="sm"
												onClick={() => setOverrideFormOpen(true)}
											>
												<Trans>Override for this project</Trans>
											</Button>
										) : overrideFormOpen &&
											data._legal.effective.source !== "project" ? (
											<Anchor
												size="sm"
												onClick={() => setOverrideFormOpen(false)}
											>
												<Trans>Cancel override</Trans>
											</Anchor>
										) : (
											<span />
										)}
										<Anchor
											size="sm"
											fw={600}
											onClick={() =>
												navigate(`/w/${workspaceId}/settings/general`)
											}
											style={{ cursor: "pointer" }}
										>
											<Group gap={4} wrap="nowrap">
												<Trans>Workspace settings</Trans>
												<IconExternalLink size={14} />
											</Group>
										</Anchor>
									</Group>
								)}

								<ConfirmModal
									opened={removeModalOpen}
									onClose={closeRemoveModal}
									onConfirm={() =>
										mutation.mutate({
											legal_basis: null,
											privacy_policy_url: null,
										})
									}
									loading={mutation.isPending}
									title={t`Remove override`}
									message={
										<Trans>
											This project will follow the inherited setting instead:{" "}
											{LEGAL_BASIS_LABELS[data._legal.inherited.legal_basis]()}{" "}
											({sourceLabel(data._legal.inherited.source)}).
										</Trans>
									}
									confirmLabel={t`Remove override`}
									data-testid="legal-basis-remove-override-modal"
								/>
							</>
						);
					})()}
			</Stack>
		</Box>
	);
};
