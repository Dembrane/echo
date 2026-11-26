import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Modal,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";
import type { DocumentDetailT } from "../contract/contract.gen";
import { NewSignerNotice, signerQuestion } from "../customer/room/confirm";
import { signText } from "../customer/room/copy";

/** Who signs for the customer as a form holds it: empty strings where nothing is set. */
export interface CustomerSigner {
	email: string;
	name: string;
	role: string;
}

export const customerSignerForm = (
	s:
		| { email: string; name: string | null; role: string | null }
		| null
		| undefined,
): CustomerSigner => ({
	email: s?.email ?? "",
	name: s?.name ?? "",
	role: s?.role ?? "",
});

/**
 * The request's `customer_signer`: null when nothing is typed. Half filled goes as typed,
 * so the API answers which field is missing, next to it.
 */
export const customerSignerBody = (s: CustomerSigner) =>
	s.name.trim() || s.email.trim()
		? {
				email: s.email.trim(),
				name: s.name.trim(),
				role: s.role.trim() || null,
			}
		: null;

/**
 * "Who signs for the customer?": name, email and job title, as the customer names a
 * signer. `prefix` is where the API puts its field errors (`customer_signer.` on an offer,
 * none on the signer route).
 */
export function CustomerSignerFields({
	value,
	onChange,
	errors,
	prefix = "",
	hint,
	heading = true,
}: {
	value: CustomerSigner;
	onChange: (v: CustomerSigner) => void;
	errors: Record<string, string>;
	prefix?: string;
	hint: string;
	/** False inside a dialog whose title asks the question already. */
	heading?: boolean;
}) {
	const set = (patch: Partial<CustomerSigner>) =>
		onChange({ ...value, ...patch });
	return (
		<Stack gap="xs" data-testid="customer-signer">
			<Stack gap={0}>
				{heading && (
					<Text size="sm">
						<Trans>Who signs for the customer?</Trans>
					</Text>
				)}
				<Text size={heading ? "xs" : "sm"} c="dimmed">
					{hint}
				</Text>
			</Stack>
			<SimpleGrid cols={{ base: 1, sm: 3 }}>
				<TextInput
					label={t`Name`}
					value={value.name}
					maxLength={200}
					onChange={(e) => set({ name: e.currentTarget.value })}
					error={errors[`${prefix}name`]}
					data-testid="customer-signer-name"
				/>
				<TextInput
					label={t`Email`}
					value={value.email}
					maxLength={255}
					onChange={(e) => set({ email: e.currentTarget.value })}
					error={errors[`${prefix}email`]}
					data-testid="customer-signer-email"
				/>
				<TextInput
					label={t`Job title`}
					placeholder={t`Optional`}
					value={value.role}
					maxLength={200}
					onChange={(e) => set({ role: e.currentTarget.value })}
					data-testid="customer-signer-role"
				/>
			</SimpleGrid>
		</Stack>
	);
}

/** The person as one line: name, job title, address. */
const personLine = (s: NonNullable<DocumentDetailT["signer"]>) =>
	[s.name, s.role].filter(Boolean).join(", ") +
	(s.name ? ` (${s.email})` : s.email);

/**
 * On the staff view of an offer or a DPA: who signs it for the customer, or that nobody is
 * named yet. While it waits for them, staff name or change the signer here; a change is
 * confirmed first, since the person named before loses their link. A draft offer shows
 * the person it will name when sent; it is changed in the draft itself.
 */
export function CustomerSignerLine({
	orgId,
	doc,
}: {
	orgId: string;
	doc: DocumentDetailT;
}) {
	const [open, setOpen] = useState(false);
	if (doc.kind !== "offer" && doc.kind !== "dpa") return null;
	if (!doc.requires_signature) return null;
	const draft = doc.status === "draft";
	const waiting =
		["sent", "viewed"].includes(doc.status) &&
		!doc.signatures.some((s) => s.slot !== "dembrane");
	if (!draft && !waiting) return null;
	const who = doc.signer ? personLine(doc.signer) : null;
	return (
		<Group gap="xs" align="center" data-testid="customer-signer-line">
			<Text size="sm">
				<Text span size="sm" c="dimmed">
					{signText(doc.kind)}:
				</Text>{" "}
				{who ? (
					<span data-testid="customer-signer-who">{who}</span>
				) : (
					<span data-testid="customer-signer-nobody">
						<Trans>
							nobody named yet. Anyone who runs the account may sign.
						</Trans>
					</span>
				)}
				{draft && who && (
					<Text span size="sm" c="dimmed">
						{" "}
						<Trans>They get the link when the offer is sent.</Trans>
					</Text>
				)}
			</Text>
			{waiting && (
				<Button
					size="compact-sm"
					variant="subtle"
					onClick={() => setOpen(true)}
					data-testid="customer-signer-open"
				>
					{doc.signer ? <Trans>Change</Trans> : <Trans>Name the signer</Trans>}
				</Button>
			)}
			{waiting && (
				<NameSignerModal
					opened={open}
					onClose={() => setOpen(false)}
					orgId={orgId}
					doc={doc}
				/>
			)}
		</Group>
	);
}

/** Names or changes the signer through the staff route; a change asks first. */
function NameSignerModal({
	opened,
	onClose,
	orgId,
	doc,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	doc: DocumentDetailT;
}) {
	const kind = doc.kind as "offer" | "dpa";
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			size="lg"
			title={
				doc.signer
					? signerQuestion([{ kind }])
					: kind === "dpa"
						? t`Who signs the DPA?`
						: t`Who signs the offer?`
			}
		>
			{/* Mounted on opening, so each opening starts from the document as it is. */}
			<NameSignerForm
				key={doc.signer?.email ?? ""}
				onClose={onClose}
				orgId={orgId}
				doc={doc}
			/>
		</Modal>
	);
}

function NameSignerForm({
	onClose,
	orgId,
	doc,
}: {
	onClose: () => void;
	orgId: string;
	doc: DocumentDetailT;
}) {
	const kind = doc.kind as "offer" | "dpa";
	const [value, setValue] = useState<CustomerSigner>(() =>
		customerSignerForm(null),
	);
	const [confirming, setConfirming] = useState(false);
	const name = useAccountsMutation("staffNameSigner", {
		docId: doc.id,
		orgId,
	});
	const fields =
		name.error instanceof AccountsApiError ? name.error.fields : {};
	const before = doc.signer;
	const newName = value.name.trim() || value.email.trim();
	const replaces =
		before !== null &&
		before.email.toLowerCase() !== value.email.trim().toLowerCase();

	const submit = () =>
		name.mutate(
			{
				body: {
					email: value.email.trim(),
					name: value.name.trim(),
					role: value.role.trim() || null,
				},
			},
			{
				onError: () => setConfirming(false),
				onSuccess: () => {
					toast.success(
						before && !replaces
							? t`${newName} stays the signer. Their link still works.`
							: t`${newName} gets an email with a link to sign.`,
					);
					onClose();
				},
			},
		);

	if (confirming && before)
		return (
			<Stack gap="md" data-testid="customer-signer-confirm">
				<NewSignerNotice
					replaced={[
						{
							email: before.email,
							isMe: false,
							kind,
							name: before.name || before.email,
						},
					]}
					newName={newName}
				/>
				<Group gap="xs">
					<Button
						variant="filled"
						onClick={submit}
						loading={name.isPending}
						data-testid="customer-signer-confirm-change"
					>
						<Trans>Change who signs</Trans>
					</Button>
					<Button
						variant="subtle"
						color="gray"
						onClick={() => setConfirming(false)}
					>
						<Trans>Back</Trans>
					</Button>
				</Group>
			</Stack>
		);

	return (
		<Stack gap="md">
			{before && (
				<Text size="sm" data-testid="customer-signer-now">
					{t`${personLine(before)} signs it now.`}
				</Text>
			)}
			<CustomerSignerFields
				value={value}
				onChange={setValue}
				errors={fields}
				heading={false}
				hint={t`They get an email with a link to sign, and log in with a code sent to that address.`}
			/>
			<Group gap="xs">
				<Button
					variant="filled"
					onClick={() => (replaces ? setConfirming(true) : submit())}
					loading={name.isPending && !confirming}
					data-testid="customer-signer-save"
				>
					<Trans>Name the signer</Trans>
				</Button>
				<Button variant="subtle" color="gray" onClick={onClose}>
					<Trans>Cancel</Trans>
				</Button>
			</Group>
			{name.error && !Object.keys(fields).length && (
				<ErrorNotice error={name.error} />
			)}
		</Stack>
	);
}
