import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, List, Loader, Stack, Text } from "@mantine/core";
import { CheckIcon, FileIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";
import type { FileRefusal } from "../limits";
import { refusalMessage } from "../messages";

export type FileState =
	| { name: string; state: "waiting" | "reading" }
	| { name: string; state: "done"; chars: number; cut: boolean }
	| { name: string; state: "refused"; reason: FileRefusal };

interface DigestProgressProps {
	files: readonly FileState[];
	/** Reading the files in the browser, then dembrane reading the material. */
	phase: "files" | "material";
	onCancel?: () => void;
	compact?: boolean;
}

/**
 * Progress while the material is read: each file's own state (waiting, reading, read, or
 * why it was not), then one "Reading your material" while dembrane prepares the setup.
 * Cancellable. Announced politely. Props in, callbacks out.
 */
export const DigestProgress = ({
	files,
	phase,
	onCancel,
	compact = false,
}: DigestProgressProps) => (
	<Stack gap="sm" {...testId("project-digest-progress")}>
		{files.length > 0 && <FileList files={files} />}
		<Group gap="sm" aria-live="polite" wrap="nowrap">
			<Loader size="sm" aria-hidden />
			<Text size="sm" {...testId("project-digest-progress-status")}>
				{phase === "files" ? (
					<Trans>Reading your files on this device…</Trans>
				) : (
					<Trans>Reading your material</Trans>
				)}
			</Text>
		</Group>
		{phase === "material" && !compact && (
			<Text size="xs" className="app-muted">
				<Trans>This takes up to half a minute for long documents.</Trans>
			</Text>
		)}
		{onCancel && (
			<Button
				variant="subtle"
				color="gray"
				size="xs"
				w="fit-content"
				onClick={onCancel}
				{...testId("project-digest-cancel")}
			>
				<Trans>Cancel</Trans>
			</Button>
		)}
	</Stack>
);

/** The files and what became of each; also shown when none could be read. */
export const FileList = ({ files }: { files: readonly FileState[] }) => (
	<List
		spacing={4}
		size="sm"
		listStyleType="none"
		aria-label={t`Your files`}
		{...testId("project-digest-files")}
	>
		{files.map((f, i) => (
			<List.Item
				// biome-ignore lint/suspicious/noArrayIndexKey: two files may share a name
				key={`${f.name}-${i}`}
				icon={
					f.state === "done" ? (
						<CheckIcon size={16} aria-hidden color="var(--app-success)" />
					) : f.state === "refused" ? (
						<WarningCircleIcon
							size={16}
							aria-hidden
							color="var(--app-danger)"
						/>
					) : f.state === "reading" ? (
						<Loader size={14} aria-hidden />
					) : (
						<FileIcon size={16} aria-hidden />
					)
				}
				{...testId(`project-digest-file-${i}`)}
			>
				<Text size="sm" span style={{ overflowWrap: "anywhere" }}>
					{f.name}
				</Text>
				<Text size="xs" className="app-muted" span>
					{" "}
					{f.state === "waiting" && <Trans>waiting</Trans>}
					{f.state === "reading" && <Trans>reading</Trans>}
					{f.state === "done" &&
						(f.cut ? (
							<Trans>
								read, only the start: the files together are too long
							</Trans>
						) : (
							<Trans>read</Trans>
						))}
				</Text>
				{f.state === "refused" && (
					<Text
						size="xs"
						c="var(--app-danger-on-tint)"
						{...testId(`project-digest-file-${i}-reason`)}
					>
						{refusalMessage(f.reason)}
					</Text>
				)}
			</List.Item>
		))}
	</List>
);
