import { Trans } from "@lingui/react/macro";
import { Box, Group, Loader, Stack, Text } from "@mantine/core";
import { HourglassSimpleIcon } from "@phosphor-icons/react";
import { usePdfData } from "../api/hooks";
import { PdfPages } from "../pdf/PdfPages";

/**
 * A document someone else signs, to read along: the pages in a frame, under a band saying
 * whose it is. Nothing on it can be filled in or signed.
 */
export function DocumentPreview({
	doc,
	who,
}: {
	doc: { file_url: string | null };
	/** "Taylor Lake, Mayor": whom it is assigned to. */
	who: string;
}) {
	const pdf = usePdfData(doc.file_url);
	return (
		<Box
			data-testid="document-preview"
			bg="var(--app-surface)"
			style={{ border: "var(--app-stroke) solid var(--app-control-rule)" }}
		>
			<Group
				gap="xs"
				wrap="nowrap"
				px="md"
				py="sm"
				bg="var(--app-action-tint)"
				data-testid="document-preview-band"
			>
				<HourglassSimpleIcon size={16} aria-hidden style={{ flexShrink: 0 }} />
				<Text size="xs">
					<Trans>Assigned to {who}. Only they can sign it.</Trans>
				</Text>
			</Group>
			<Box p="md">
				{pdf.data ? (
					<PdfPages data={pdf.data} />
				) : pdf.isError ? (
					<Text size="sm" c="dimmed">
						<Trans>
							The document could not be loaded. Try again in a moment.
						</Trans>
					</Text>
				) : (
					<Stack align="center" py="xl">
						<Loader size="sm" />
					</Stack>
				)}
			</Box>
		</Box>
	);
}
