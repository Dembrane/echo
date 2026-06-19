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
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
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
		throw new Error(data.detail || "Could not create the organisation");
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
		throw new Error(data.detail || "Failed to send invite");
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

	const reset = () => {
		setStep(0);
		setOrgName("");
		setEmails([""]);
		setCreated(null);
	};

	const finish = () => {
		const orgId = created?.org_id;
		reset();
		onClose();
		if (orgId) navigate(`/o/${orgId}`);
	};

	const createMutation = useMutation({
		mutationFn: (name: string) => createOrganisation(name),
		onError: (err: Error) =>
			toast.error(err.message || t`Could not create the organisation`),
		onSuccess: (result) => {
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
					toast.error(
						`${email}: ${err instanceof Error ? err.message : t`Failed`}`,
					);
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
		<Modal
			opened={opened}
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
							<Group justify="flex-end">
								<Button variant="subtle" onClick={handleClose} disabled={busy}>
									<Trans>Cancel</Trans>
								</Button>
								<Button type="submit" loading={busy} disabled={!orgName.trim()}>
									<Trans>Continue</Trans>
								</Button>
							</Group>
						</Stack>
					</form>
				) : (
					<Stack gap="md">
						<Text size="sm">
							<Trans>
								Colleagues you invite can explore conversations, share insights,
								and build reports with you.
							</Trans>
						</Text>
						<InviteEmailList
							emails={emails}
							onChange={setEmails}
							autoFocusFirst
						/>
						<Group justify="flex-end">
							<Button variant="subtle" onClick={finish} disabled={busy}>
								<Trans>Skip</Trans>
							</Button>
							<Button
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
	);
};
