import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	FileButton,
	Group,
	Modal,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useAccountsMutation } from "../api/hooks";
import type { DocumentDetailT } from "../contract/contract.gen";
import {
	type CapturedImage,
	SignatureCapture,
} from "../signing/SignatureCapture";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ANNEXES = 5;

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

/**
 * Staff, on a draft offer: the PDFs attached to it. Each is named here, listed in the
 * offer's clause and follows its pages in the PDF the customer signs.
 */
export function AnnexesPanel({
	orgId,
	doc,
}: {
	orgId: string;
	doc: DocumentDetailT;
}) {
	const annexes = doc.content?.annexes ?? [];
	const [name, setName] = useState("");
	const [fileError, setFileError] = useState<string | null>(null);
	const add = useAccountsMutation("addAnnex", { orgId });
	const remove = useAccountsMutation("removeAnnex", { orgId });

	const pick = async (file: File | null) => {
		setFileError(null);
		if (!file) return;
		if (file.size > MAX_BYTES) {
			setFileError(t`That file is over 10 MB.`);
			return;
		}
		add.mutate(
			{
				body: {
					name: name.trim() || file.name.replace(/\.pdf$/i, ""),
					pdf_base64: await toBase64(file),
				},
				params: { docId: doc.id },
			},
			{ onSuccess: () => setName("") },
		);
	};

	return (
		<Stack gap="xs" data-testid="offer-annexes">
			<Text size="sm">
				<Trans>Annexes</Trans>
			</Text>
			{annexes.map((a) => (
				<Group key={a.number} gap="xs" wrap="nowrap" data-testid="offer-annex">
					<Text size="sm" style={{ flex: 1 }}>
						{a.number}. {a.name}
					</Text>
					<Text size="xs" c="dimmed">
						{a.pages === 1 ? (
							<Trans>1 page</Trans>
						) : (
							<Trans>{a.pages} pages</Trans>
						)}
					</Text>
					<ActionIcon
						variant="subtle"
						color="gray"
						aria-label={t`Remove annex`}
						loading={remove.isPending}
						onClick={() =>
							remove.mutate({
								params: { docId: doc.id, number: String(a.number) },
							})
						}
					>
						<TrashIcon size={16} />
					</ActionIcon>
				</Group>
			))}
			{annexes.length < MAX_ANNEXES && (
				<Group gap="xs" align="flex-end" wrap="nowrap">
					<TextInput
						label={t`Annex name`}
						placeholder={t`Project plan`}
						value={name}
						maxLength={120}
						onChange={(e) => setName(e.currentTarget.value)}
						style={{ flex: 1 }}
						data-testid="annex-name"
					/>
					<FileButton
						onChange={(f) => void pick(f)}
						accept="application/pdf,.pdf"
					>
						{(props) => (
							<Button
								{...props}
								variant="default"
								loading={add.isPending}
								data-testid="annex-file"
							>
								<Trans>Add a PDF</Trans>
							</Button>
						)}
					</FileButton>
				</Group>
			)}
			{fileError && (
				<Text size="xs" c="red">
					{fileError}
				</Text>
			)}
			{(add.error ?? remove.error) && (
				<ErrorNotice error={add.error ?? remove.error} />
			)}
		</Stack>
	);
}

/**
 * Staff: dembrane's counter-signature, by the person the offer names. They draw or type
 * their signature; the date is today's.
 */
export function CountersignModal({
	opened,
	onClose,
	orgId,
	doc,
	name,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	doc: DocumentDetailT;
	name: string;
}) {
	const sign = useAccountsMutation("countersign", { orgId });
	const submit = (image: CapturedImage) =>
		sign.mutate(
			{
				body: {
					signature: { method: image.method, png_base64: image.png_base64 },
				},
				params: { docId: doc.id },
			},
			{
				onSuccess: () => {
					toast.success(t`Counter-signed`);
					onClose();
				},
			},
		);
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Sign for dembrane`}
			centered
		>
			<Stack gap="sm" data-testid="countersign">
				<Text size="sm" c="dimmed">
					<Trans>Signs {doc.title} as shown.</Trans>
				</Text>
				<SignatureCapture
					suggestedText={name}
					purpose="signature"
					onCapture={submit}
				/>
				{sign.error && <ErrorNotice error={sign.error} />}
			</Stack>
		</Modal>
	);
}
