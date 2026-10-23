import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Checkbox,
	FileButton,
	Group,
	Modal,
	Radio,
	SegmentedControl,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useAccountsMutation, useDocument } from "../api/hooks";
import type { DocumentSummaryT } from "../contract/contract.gen";

const MAX_BYTES = 10 * 1024 * 1024;

type Via = "order_letter" | "email" | "paper" | "own_document";

/** How the customer accepted, as staff pick it and the documents list says it. */
export const outsideViaLabel = (via: Via): string =>
	({
		email: t`By email`,
		order_letter: t`Their order letter`,
		own_document: t`Their own DPA`,
		paper: t`Signed on paper`,
	})[via];

/** How and when, for the facts line: "Accepted by order letter, Oct 23, 2026". */
export const outsideFact = (via: Via, day: string): string =>
	({
		email: t`Accepted by email, ${day}`,
		order_letter: t`Accepted by order letter, ${day}`,
		own_document: t`Their own DPA signed, ${day}`,
		paper: t`Signed on paper, ${day}`,
	})[via];

const toBase64 = (file: File): Promise<string> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			resolve(url.slice(url.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});

/** Today in the browser's own calendar, as a date input wants it. */
const today = () => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Staff: the customer accepted a sent offer outside dembrane (their order letter, an email,
 * a signature on paper), or signed the DPA on paper or as their own. One decision: record
 * it, with who, when and the evidence. It counts as their signature.
 */
export function AcceptedOutsideModal({
	opened,
	onClose,
	orgId,
	doc,
	reference,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	doc: Pick<DocumentSummaryT, "id" | "kind" | "title">;
	/** The reference the offer carries, offered as theirs. */
	reference?: string | null;
}) {
	const isDpa = doc.kind === "dpa";
	const ways: Via[] = isDpa
		? ["paper", "own_document"]
		: ["order_letter", "email", "paper"];
	const [via, setVia] = useState<Via>(ways[0] as Via);
	const [name, setName] = useState("");
	const [role, setRole] = useState("");
	const [email, setEmail] = useState("");
	const [on, setOn] = useState(today());
	const [ref, setRef] = useState(reference ?? "");
	const [file, setFile] = useState<File | null>(null);
	const [fileError, setFileError] = useState<string | null>(null);
	const accept = useAccountsMutation("acceptOutside", { orgId });
	// An offer with options: what the customer chose, as their letter or email says it.
	const detail = useDocument(orgId, isDpa ? undefined : doc.id, true);
	const options = [
		...new Set(
			(detail.data?.content?.items ?? []).flatMap((i) =>
				i.option ? [i.option] : [],
			),
		),
	];
	const pickOne = detail.data?.content?.choose === "one";
	const [chosen, setChosen] = useState<string[]>([]);

	const pick = (f: File | null) => {
		setFileError(null);
		if (f && f.size > MAX_BYTES) {
			setFileError(t`That file is over 10 MB.`);
			return;
		}
		setFile(f);
	};

	const submit = async () => {
		if (!file) return;
		accept.mutate(
			{
				body: {
					accepted_on: on,
					customer_reference: isDpa ? null : ref.trim() || null,
					...(options.length && { chosen_options: chosen }),
					email: email.trim(),
					evidence_base64: await toBase64(file),
					evidence_name: file.name,
					name: name.trim(),
					role: role.trim() || null,
					via,
				},
				params: { docId: doc.id },
			},
			{
				onSuccess: () => {
					onClose();
					toast.success(isDpa ? t`DPA recorded as signed` : t`Offer accepted`);
				},
			},
		);
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={isDpa ? t`Signed outside dembrane` : t`Accepted outside dembrane`}
			centered
		>
			<Stack gap="sm" data-testid="accepted-outside">
				<Text size="sm" c="dimmed">
					<Trans>Counts as their signature.</Trans>
				</Text>
				<Stack gap={4}>
					<Text size="sm">
						<Trans>How</Trans>
					</Text>
					<SegmentedControl
						size="xs"
						value={via}
						onChange={(v) => setVia(v as Via)}
						data={ways.map((w) => ({ label: outsideViaLabel(w), value: w }))}
						data-testid="outside-via"
					/>
				</Stack>
				<Group grow align="flex-start">
					<TextInput
						label={isDpa ? t`Signed by` : t`Accepted by`}
						placeholder={t`Name`}
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						data-testid="outside-name"
					/>
					<TextInput
						label={t`Role`}
						placeholder={t`Optional`}
						value={role}
						onChange={(e) => setRole(e.currentTarget.value)}
						data-testid="outside-role"
					/>
				</Group>
				<Group grow align="flex-start">
					<TextInput
						label={t`Email`}
						type="email"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						data-testid="outside-email"
					/>
					<TextInput
						label={isDpa ? t`Date signed` : t`Date accepted`}
						type="date"
						value={on}
						onChange={(e) => setOn(e.currentTarget.value)}
						data-testid="outside-date"
					/>
				</Group>
				{!isDpa && (
					<TextInput
						label={t`Their reference`}
						description={t`Goes on the invoice`}
						placeholder={t`PO number`}
						value={ref}
						onChange={(e) => setRef(e.currentTarget.value)}
						data-testid="outside-reference"
					/>
				)}
				{options.length > 0 &&
					(pickOne ? (
						<Radio.Group
							label={t`They chose`}
							value={chosen[0] ?? null}
							onChange={(v) => setChosen([v])}
							data-testid="outside-options"
						>
							<Stack gap={6} mt={6}>
								{options.map((o) => (
									<Radio key={o} value={o} label={o} />
								))}
							</Stack>
						</Radio.Group>
					) : (
						<Checkbox.Group
							label={t`They chose`}
							value={chosen}
							onChange={setChosen}
							data-testid="outside-options"
						>
							<Stack gap={6} mt={6}>
								{options.map((o) => (
									<Checkbox key={o} value={o} label={o} />
								))}
							</Stack>
						</Checkbox.Group>
					))}
				<Stack gap={4}>
					<Text size="sm">
						<Trans>Evidence</Trans>
					</Text>
					<Group gap="sm" wrap="nowrap">
						<FileButton
							onChange={pick}
							accept="application/pdf,.pdf,message/rfc822,.eml"
						>
							{(props) => (
								<Button
									variant="default"
									size="xs"
									{...props}
									data-testid="outside-file"
								>
									<Trans>Choose a file</Trans>
								</Button>
							)}
						</FileButton>
						<Text size="sm" c="dimmed" truncate>
							{file?.name ?? t`PDF, or the email as EML`}
						</Text>
					</Group>
					{fileError && (
						<Text size="sm" c="red">
							{fileError}
						</Text>
					)}
				</Stack>
				{accept.error && <ErrorNotice error={accept.error} />}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						disabled={
							!file ||
							!name.trim() ||
							!email.trim() ||
							!on ||
							(pickOne && chosen.length !== 1)
						}
						loading={accept.isPending}
						onClick={submit}
						data-testid="outside-submit"
					>
						{isDpa ? (
							<Trans>Record signature</Trans>
						) : (
							<Trans>Record acceptance</Trans>
						)}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

/**
 * Staff: undo an acceptance recorded outside dembrane (the wrong letter, the wrong offer).
 * The document is withdrawn; the record stays, with the reason.
 */
export function VoidAcceptanceModal({
	opened,
	onClose,
	orgId,
	docId,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	docId: string;
}) {
	const [reason, setReason] = useState("");
	const voidDoc = useAccountsMutation("voidDocument", { orgId });
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Void this acceptance`}
			centered
		>
			<Stack gap="sm" data-testid="void-acceptance">
				<Textarea
					label={t`Reason`}
					description={t`The record keeps your reason.`}
					autosize
					minRows={2}
					value={reason}
					onChange={(e) => setReason(e.currentTarget.value)}
					data-testid="void-reason"
				/>
				{voidDoc.error && <ErrorNotice error={voidDoc.error} />}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						color="red"
						disabled={!reason.trim()}
						loading={voidDoc.isPending}
						onClick={() =>
							voidDoc.mutate(
								{ body: { reason: reason.trim() }, params: { docId } },
								{
									onSuccess: () => {
										onClose();
										toast.success(t`Acceptance voided`);
									},
								},
							)
						}
						data-testid="void-submit"
					>
						<Trans>Void acceptance</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
