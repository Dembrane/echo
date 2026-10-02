import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	FileButton,
	Group,
	Modal,
	SegmentedControl,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useAccountsMutation } from "../api/hooks";

const MAX_BYTES = 10 * 1024 * 1024;

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
 * Staff: any PDF for the customer (their own DPA, a purchase order form, a workshop plan).
 * One that needs a signature stays a draft and opens the field editor; one that does not
 * is sent straight away.
 */
export function UploadPdfModal({
	opened,
	onClose,
	orgId,
	onDraft,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	onDraft: (docId: string) => void;
}) {
	const [file, setFile] = useState<File | null>(null);
	const [title, setTitle] = useState("");
	const [kind, setKind] = useState<"other" | "dpa">("other");
	const [language, setLanguage] = useState<"en" | "nl">("nl");
	const [sign, setSign] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const push = useAccountsMutation("pushDocument", { orgId });

	const pick = (f: File | null) => {
		setError(null);
		if (f && f.size > MAX_BYTES) {
			setError(t`That PDF is over 10 MB.`);
			return;
		}
		setFile(f);
		if (f && !title) setTitle(f.name.replace(/\.pdf$/i, ""));
	};

	const submit = async () => {
		if (!file) return;
		const pdf = await toBase64(file);
		push.mutate(
			{
				body: {
					kind,
					language,
					pdf_base64: pdf,
					requires_signature: sign,
					send: !sign,
					task: sign
						? {
								body: null,
								title:
									language === "nl" ? `Onderteken: ${title}` : `Sign: ${title}`,
							}
						: {
								body: null,
								title: language === "nl" ? `Lees: ${title}` : `Read: ${title}`,
							},
					title,
				},
			},
			{
				onSuccess: (res) => {
					setFile(null);
					setTitle("");
					onClose();
					if (sign) onDraft(res.document.id);
					else toast.success(t`Sent`);
				},
			},
		);
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t`Upload a PDF`} centered>
			<Stack gap="sm">
				<Group gap="sm" wrap="nowrap">
					<FileButton onChange={pick} accept="application/pdf">
						{(props) => (
							<Button variant="default" {...props} data-testid="upload-choose">
								<Trans>Choose a PDF</Trans>
							</Button>
						)}
					</FileButton>
					<Text size="sm" c="dimmed" truncate>
						{file?.name ?? <Trans>No file chosen</Trans>}
					</Text>
				</Group>
				{error && (
					<Text size="sm" c="red">
						{error}
					</Text>
				)}
				<TextInput
					label={t`Title`}
					value={title}
					onChange={(e) => setTitle(e.currentTarget.value)}
					data-testid="upload-title"
				/>
				<Group grow>
					<Stack gap={4}>
						<Text size="sm">
							<Trans>Kind</Trans>
						</Text>
						<SegmentedControl
							size="xs"
							value={kind}
							onChange={(v) => setKind(v as typeof kind)}
							data={[
								{ label: t`Document`, value: "other" },
								{ label: t`DPA`, value: "dpa" },
							]}
						/>
					</Stack>
					<Stack gap={4}>
						<Text size="sm">
							<Trans>Language</Trans>
						</Text>
						<SegmentedControl
							size="xs"
							value={language}
							onChange={(v) => setLanguage(v as typeof language)}
							data={[
								{ label: "NL", value: "nl" },
								{ label: "EN", value: "en" },
							]}
						/>
					</Stack>
				</Group>
				<Switch
					label={t`Needs a signature`}
					description={
						sign
							? t`Next you place the fields, then send it.`
							: t`Sent right away, to read.`
					}
					checked={sign}
					onChange={(e) => setSign(e.currentTarget.checked)}
				/>
				{push.error && <ErrorNotice error={push.error} />}
				<Group justify="flex-end">
					<Button
						disabled={!file || !title.trim()}
						loading={push.isPending}
						onClick={submit}
						data-testid="upload-submit"
					>
						{sign ? (
							<Trans>Upload and place fields</Trans>
						) : (
							<Trans>Upload and send</Trans>
						)}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
