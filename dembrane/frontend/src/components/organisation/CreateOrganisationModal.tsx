import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Modal,
	Stack,
	Stepper,
	Text,
	TextInput,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useManagedFreeOrg } from "@/hooks/useManagedFreeOrg";
import { useWorkspace } from "@/hooks/useWorkspace";
import { ApiRequestError } from "@/lib/errors/read";
import { toastForEmail } from "@/lib/errors/toastForEmail";
import { freeLimitDetails, isFreeTierLimitError } from "@/lib/freeTier";
import { InviteEmailList } from "./InviteEmailList";

type CreatedOrg = { org_id: string; workspace_id: string };

async function createOrganisation(name: string): Promise<CreatedOrg> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs`, {
		body: JSON.stringify({ name }),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, data);
	}
	return res.json();
}

async function sendInvite(workspaceId: string, email: string) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`,
		{
			body: JSON.stringify({ email, role: "member" }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, data);
	}
	return res.json();
}

/**
 * Two-step create-organisation flow (organisation name, then optional invites),
 * mirroring onboarding minus the questionnaire. The org + its default workspace
 * are created when the user leaves step 1, so step 2 can invite into the real
 * workspace; closing afterwards still keeps the created org.
 */
export const CreateOrganisationModal = ({
	opened,
	onClose,
}: {
	opened: boolean;
	onClose: () => void;
}) => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const [step, setStep] = useState(0);
	const [orgName, setOrgName] = useState("");
	const [emails, setEmails] = useState<string[]>([""]);
	const [created, setCreated] = useState<CreatedOrg | null>(null);
	const [upgradeOpened, setUpgradeOpened] = useState(false);
	// The free org the 402 names; the wall upgrades it, not the active workspace.
	const [blocking, setBlocking] = useState<{
		orgId?: string;
		workspaceId?: string;
	}>({});
	const { workspace } = useWorkspace();
	const freeOrg = useManagedFreeOrg();
	// Already at the cap: skip the form and show the wall on open.
	const wallUpFront = opened && !!freeOrg && !created;

	const reset = () => {
		setStep(0);
		setOrgName("");
		setEmails([""]);
		setCreated(null);
	};

	const finish = async () => {
		const orgId = created?.org_id;
		await Promise.all([
			queryClient.refetchQueries({ queryKey: ["v2", "workspaces-context"] }),
			queryClient.refetchQueries({ queryKey: ["v2", "workspaces"] }),
		]);
		reset();
		onClose();
		if (orgId) navigate(`/o/${orgId}`);
	};

	const createMutation = useMutation({
		mutationFn: (name: string) => createOrganisation(name),
		onError: (err: Error) => {
			if (isFreeTierLimitError(err) === "organisations") {
				const d = freeLimitDetails(err);
				const str = (v: unknown) =>
					typeof v === "string" && v ? v : undefined;
				setBlocking({
					orgId: str(d?.org_id),
					workspaceId: str(d?.workspace_id),
				});
				reset();
				onClose();
				setUpgradeOpened(true);
				return;
			}
			void notifyError(err);
		},
		onSuccess: (result) => {
			posthog.capture("org_created", {
				org_id: result.org_id,
				workspace_id: result.workspace_id,
			});
			setCreated(result);
			// New org + workspace: refresh the sidebar (orgs are derived from the
			// workspaces context) and the me payload.
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			setStep(1);
		},
	});

	const inviteMutation = useMutation({
		// A per-recipient failure is surfaced but never aborts the rest; the org
		// already exists, so we always move on to the workspace afterwards.
		mutationFn: async (workspaceId: string) => {
			const valid = emails.filter((e) => e.trim() && e.includes("@"));
			let sent = 0;
			for (const email of valid) {
				try {
					await sendInvite(workspaceId, email.trim());
					sent++;
				} catch (err) {
					toastForEmail(email, err, i18n);
				}
			}
			return sent;
		},
		onSuccess: (sent) => {
			if (sent > 0) {
				toast.success(sent === 1 ? t`Invite sent` : t`${sent} invites sent`);
			}
			finish();
		},
	});

	const busy = createMutation.isPending || inviteMutation.isPending;

	const handleClose = () => {
		if (busy) return;
		reset();
		onClose();
	};

	const handleCreate = () => {
		const name = orgName.trim();
		if (!name) return;
		createMutation.mutate(name);
	};

	const handleSendInvites = () => {
		if (!created) {
			finish();
			return;
		}
		const hasValid = emails.some((e) => e.trim() && e.includes("@"));
		if (!hasValid) {
			finish();
			return;
		}
		inviteMutation.mutate(created.workspace_id);
	};

	const canInvite = emails.some((e) => e.trim() && e.includes("@"));

	return (
		<>
			<Modal
				opened={opened && !wallUpFront}
				onClose={handleClose}
				title={<Trans>Create organisation</Trans>}
				size="lg"
				data-testid="create-organisation-modal"
			>
				<Stack gap="lg">
					<Stepper active={step} size="sm" iconSize={28}>
						<Stepper.Step label={t`Organisation`} />
						<Stepper.Step label={t`Invite`} />
					</Stepper>

					{step === 0 ? (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								handleCreate();
							}}
						>
							<Stack gap="md">
								<Text size="sm">
									<Trans>
										Name your organisation. You can invite people next, or do it
										later from settings.
									</Trans>
								</Text>
								<TextInput
									autoFocus
									label={t`Organisation name`}
									description={t`You can change this anytime in settings.`}
									placeholder={t`Your organisation or company`}
									size="sm"
									value={orgName}
									onChange={(e) => setOrgName(e.currentTarget.value)}
									data-testid="create-organisation-name-input"
								/>
								{/* A row of steps: the quiet button on the left, the pill on the right. */}
								<Group data-steps justify="space-between">
									<Button
										variant="subtle"
										color="gray"
										onClick={handleClose}
										disabled={busy}
									>
										<Trans>Cancel</Trans>
									</Button>
									<Button
										variant="filled"
										type="submit"
										loading={busy}
										disabled={!orgName.trim()}
									>
										<Trans>Continue</Trans>
									</Button>
								</Group>
							</Stack>
						</form>
					) : (
						<Stack gap="md">
							<Text size="sm">
								<Trans>
									Colleagues you invite can explore conversations, share
									insights, and build reports with you.
								</Trans>
							</Text>
							<InviteEmailList
								emails={emails}
								onChange={setEmails}
								autoFocusFirst
							/>
							{/* A row of steps: the quiet button on the left, the pill on the right. */}
							<Group data-steps justify="space-between">
								<Button
									variant="subtle"
									color="gray"
									onClick={finish}
									disabled={busy}
								>
									<Trans>Skip</Trans>
								</Button>
								<Button
									variant="filled"
									loading={busy}
									disabled={!canInvite}
									onClick={handleSendInvites}
								>
									<Trans>Send invites</Trans>
								</Button>
							</Group>
						</Stack>
					)}
				</Stack>
			</Modal>
			<UpgradeModal
				opened={upgradeOpened || wallUpFront}
				onClose={() => {
					setUpgradeOpened(false);
					if (wallUpFront) onClose();
				}}
				// The 402 proves the account is free, whatever this workspace shows.
				currentTier="free"
				requiredTier="changemaker"
				canRequestUpgrade
				orgId={blocking.orgId ?? freeOrg?.orgId}
				workspaceId={
					blocking.workspaceId ?? freeOrg?.workspaceId ?? workspace?.id ?? ""
				}
				wallKey="org_cap"
			/>
		</>
	);
};
