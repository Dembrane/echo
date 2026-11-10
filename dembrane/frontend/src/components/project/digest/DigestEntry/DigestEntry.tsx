import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Collapse,
	Group,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import {
	CaretDownIcon,
	CaretRightIcon,
	FileArrowUpIcon,
} from "@phosphor-icons/react";
import { type ClipboardEvent, type ReactNode, useId, useState } from "react";
import { testId } from "@/lib/testUtils";
import { DIGEST_ACCEPT, MAX_FILES } from "../limits";

export interface DigestMaterial {
	files: File[];
	text: string;
	url: string;
}

interface DigestEntryProps {
	/** Files dropped, picked or pasted, with any text and link the host added first. */
	onSubmit: (material: DigestMaterial) => void;
	/** The small variant beside "Suggest key terms" on the name step. */
	compact?: boolean;
	disabled?: boolean;
	/** A quiet line under the zone: what happened last time. */
	notice?: ReactNode;
}

const looksLikeUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

/**
 * "Have an agenda or invitation? Drop it here": one quiet row with a drop zone that also
 * opens the file dialog, takes pasted text (into the zone or the "Paste text" box) and a
 * link. Files are read in this browser; the line under it always says what is sent where.
 * Props in, callbacks out.
 */
export const DigestEntry = ({
	onSubmit,
	compact = false,
	disabled = false,
	notice,
}: DigestEntryProps) => {
	const pasteId = useId();
	const linkId = useId();
	const privacyId = useId();
	const [pasteOpen, setPasteOpen] = useState(false);
	const [linkOpen, setLinkOpen] = useState(false);
	const [text, setText] = useState("");
	const [url, setUrl] = useState("");

	const submit = (files: File[]) => {
		const cleanUrl = looksLikeUrl(url) ? url.trim() : "";
		if (!files.length && !text.trim() && !cleanUrl) return;
		onSubmit({ files, text: text.trim(), url: cleanUrl });
	};

	// Pasting into the focused zone: a link goes to the link, text to the text box, files
	// (a screenshot, a copied file) go in as files.
	const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
		const files = [...e.clipboardData.files];
		const pasted = e.clipboardData.getData("text/plain");
		if (files.length) {
			e.preventDefault();
			submit(files);
		} else if (looksLikeUrl(pasted)) {
			e.preventDefault();
			setUrl(pasted.trim());
			setLinkOpen(true);
		} else if (pasted.trim()) {
			e.preventDefault();
			setText((prev) => (prev ? `${prev}\n\n${pasted}` : pasted));
			setPasteOpen(true);
		}
	};

	const ready = Boolean(text.trim()) || looksLikeUrl(url);

	return (
		<Stack
			gap="xs"
			data-tour="project-digest-entry"
			{...testId(
				compact ? "project-digest-entry-compact" : "project-digest-entry",
			)}
		>
			{!compact && (
				<Text size="sm" id={`${privacyId}-lead`}>
					<Trans>
						Have an agenda or invitation? Drop it here and dembrane sets the
						project up.
					</Trans>
				</Text>
			)}
			<Dropzone
				onDropAny={(files, rejections) =>
					submit([...files, ...rejections.map((r) => r.file)])
				}
				onDrop={() => {}}
				accept={DIGEST_ACCEPT}
				disabled={disabled}
				p={compact ? "xs" : "sm"}
				onPaste={onPaste}
				aria-label={t`Drop files or choose them`}
				aria-describedby={privacyId}
				{...testId("project-digest-dropzone")}
			>
				<Group
					gap="sm"
					wrap="nowrap"
					justify="flex-start"
					style={{ pointerEvents: "none" }}
				>
					<FileArrowUpIcon size={compact ? 20 : 24} aria-hidden />
					<Stack gap={0}>
						<Text size="sm">
							{compact ? (
								<Trans>Add from a file</Trans>
							) : (
								<Trans>Drop files here, or choose them</Trans>
							)}
						</Text>
						<Text size="xs" className="app-muted">
							<Trans>
								PDF, Word, PowerPoint or text. Up to {MAX_FILES} files of 10 MB.
							</Trans>
						</Text>
					</Stack>
				</Group>
			</Dropzone>

			<Group gap="xs" wrap="wrap">
				<Button
					variant="subtle"
					size="xs"
					leftSection={
						pasteOpen ? (
							<CaretDownIcon size={16} aria-hidden />
						) : (
							<CaretRightIcon size={16} aria-hidden />
						)
					}
					aria-expanded={pasteOpen}
					aria-controls={pasteId}
					onClick={() => setPasteOpen((o) => !o)}
					disabled={disabled}
					{...testId("project-digest-paste-toggle")}
				>
					<Trans>Paste text</Trans>
				</Button>
				<Button
					variant="subtle"
					size="xs"
					leftSection={
						linkOpen ? (
							<CaretDownIcon size={16} aria-hidden />
						) : (
							<CaretRightIcon size={16} aria-hidden />
						)
					}
					aria-expanded={linkOpen}
					aria-controls={linkId}
					onClick={() => setLinkOpen((o) => !o)}
					disabled={disabled}
					{...testId("project-digest-link-toggle")}
				>
					<Trans>Add a link</Trans>
				</Button>
			</Group>

			<Collapse in={pasteOpen}>
				<Textarea
					id={pasteId}
					label={t`Pasted text`}
					placeholder={t`Paste the agenda, the invitation or the brief.`}
					minRows={4}
					maxRows={10}
					autosize
					value={text}
					onChange={(e) => setText(e.currentTarget.value)}
					disabled={disabled}
					{...testId("project-digest-text")}
				/>
			</Collapse>
			<Collapse in={linkOpen}>
				<TextInput
					id={linkId}
					label={t`Link to a page about it`}
					description={t`An invitation or project page. dembrane reads it once.`}
					placeholder="https://"
					type="url"
					inputMode="url"
					value={url}
					onChange={(e) => setUrl(e.currentTarget.value)}
					disabled={disabled}
					{...testId("project-digest-url")}
				/>
			</Collapse>
			{(pasteOpen || linkOpen) && (
				<Button
					variant="outline"
					size="sm"
					w="fit-content"
					disabled={disabled || !ready}
					onClick={() => submit([])}
					{...testId("project-digest-submit")}
				>
					<Trans>Set up from this</Trans>
				</Button>
			)}

			{notice}

			<Text
				size="xs"
				className="app-muted"
				id={privacyId}
				{...testId("project-digest-privacy")}
			>
				<Trans>
					Files stay on your device. Only their text is sent to dembrane's model
					provider to prepare the setup. Don't drop material you may not share.
				</Trans>
			</Text>
		</Stack>
	);
};
