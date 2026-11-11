import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Modal,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useState } from "react";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";

/**
 * Staff: a new customer organisation with the person it is for, so it can get an offer
 * without a demo first. The person becomes its admin; nothing is emailed to them. The
 * offer, once sent, is what lets them in.
 */
export function NewOrganisationModal({
	opened,
	onClose,
	onCreated,
}: {
	opened: boolean;
	onClose: () => void;
	onCreated: (orgId: string) => void;
}) {
	return (
		<Modal opened={opened} onClose={onClose} title={t`New organisation`}>
			{/* Mounted on open, so each opening starts empty. */}
			<NewOrganisationForm onClose={onClose} onCreated={onCreated} />
		</Modal>
	);
}

function NewOrganisationForm({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (orgId: string) => void;
}) {
	const [name, setName] = useState("");
	const [contactName, setContactName] = useState("");
	const [email, setEmail] = useState("");
	const [language, setLanguage] = useState<"en" | "nl">("nl");
	const create = useAccountsMutation("createAccount");
	const fields =
		create.error instanceof AccountsApiError ? create.error.fields : {};

	const submit = () =>
		create.mutate(
			{
				body: {
					contact_email: email.trim(),
					contact_name: contactName.trim() || null,
					language,
					organisation_name: name.trim(),
					pricing_configuration_reference: null,
					stage: "prospect",
				},
			},
			{
				onSuccess: (res) => {
					onClose();
					onCreated(res.org_id);
				},
			},
		);

	return (
		<Stack gap="sm">
			<TextInput
				label={t`Organisation name`}
				value={name}
				onChange={(e) => setName(e.currentTarget.value)}
				error={fields.organisation_name}
				data-autofocus
				data-testid="new-org-name"
			/>
			<TextInput
				label={t`Contact name`}
				value={contactName}
				onChange={(e) => setContactName(e.currentTarget.value)}
				error={fields.contact_name}
				data-testid="new-org-contact-name"
			/>
			<TextInput
				label={t`Contact email`}
				description={t`They can sign the offer`}
				type="email"
				value={email}
				onChange={(e) => setEmail(e.currentTarget.value)}
				error={fields.contact_email}
				data-testid="new-org-contact-email"
			/>
			<Stack gap={4}>
				<Text size="sm">
					<Trans>Language</Trans>
				</Text>
				<SegmentedControl
					value={language}
					onChange={(v) => setLanguage(v as typeof language)}
					data={[
						{ label: "Nederlands", value: "nl" },
						{ label: "English", value: "en" },
					]}
				/>
			</Stack>
			{create.error && !Object.keys(fields).length && (
				<ErrorNotice error={create.error} />
			)}
			<Button
				onClick={submit}
				loading={create.isPending}
				disabled={!name.trim() || !email.trim()}
				style={{ alignSelf: "flex-end" }}
				data-testid="new-org-submit"
			>
				<Trans>Create organisation</Trans>
			</Button>
		</Stack>
	);
}
