import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	CopyButton,
	Group,
	Paper,
	Stack,
	Switch,
	Text,
	Textarea,
	Title,
} from "@mantine/core";
import {
	ArrowSquareOutIcon,
	CheckIcon,
	CodeIcon,
	CopyIcon,
	LinkIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import {
	type PopcornDetail,
	popcornEmbedSnippet,
	popcornPublicUrl,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { FIELD_SIZE } from "@/components/popcorn/PopcornVoiceSection";
import { testId } from "@/lib/testUtils";

// Sharing, the way a video site does it: one switch to make the page public,
// then Link or Embed, each with the thing to copy right there.
export function PopcornShare({
	projectId,
	popcorn,
}: {
	projectId: string;
	popcorn: PopcornDetail;
}) {
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	const [showEmbed, setShowEmbed] = useState(false);
	const token = popcorn.public_token;
	const publicUrl = token ? popcornPublicUrl(token) : null;
	const isPublic = popcorn.settings.public && !!publicUrl;
	const embed = token ? popcornEmbedSnippet(token) : "";

	return (
		<Paper
			withBorder
			className="rounded-md"
			p="lg"
			{...testId("popcorn-share")}
		>
			<Stack gap="md">
				<Title order={4}>
					<Trans>Share</Trans>
				</Title>
				<Switch
					size={FIELD_SIZE}
					label={t`Public page`}
					description={t`Anyone with the link can watch. No login, and no transcripts.`}
					checked={popcorn.settings.public}
					disabled={settings.isPending}
					onChange={(event) =>
						settings.mutate({ public: event.currentTarget.checked })
					}
					{...testId("popcorn-public-toggle")}
				/>
				{isPublic && publicUrl ? (
					<>
						<Group grow gap="sm" align="stretch">
							<CopyButton value={publicUrl} timeout={2000}>
								{({ copied, copy }) => (
									<Button
										variant={copied ? "filled" : "outline"}
										leftSection={
											copied ? <CheckIcon size={16} /> : <LinkIcon size={16} />
										}
										onClick={copy}
										{...testId("popcorn-copy-link")}
									>
										{copied ? t`Link copied` : t`Share link`}
									</Button>
								)}
							</CopyButton>
							<Button
								variant="outline"
								leftSection={<CodeIcon size={16} />}
								onClick={() => setShowEmbed((current) => !current)}
								{...testId("popcorn-share-embed")}
							>
								<Trans>Embed in a webpage</Trans>
							</Button>
						</Group>
						{showEmbed ? (
							<Stack gap="xs">
								<Textarea
									value={embed}
									readOnly
									autosize
									minRows={3}
									styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
									aria-label={t`Embed code`}
									{...testId("popcorn-embed-code")}
								/>
								<Group justify="space-between" align="center">
									<Text size="xs">
										<Trans>Paste it into any page. It stays live.</Trans>
									</Text>
									<CopyButton value={embed} timeout={2000}>
										{({ copied, copy }) => (
											<Button
												size="xs"
												onClick={copy}
												leftSection={
													copied ? (
														<CheckIcon size={14} />
													) : (
														<CopyIcon size={14} />
													)
												}
												{...testId("popcorn-copy-embed")}
											>
												{copied ? t`Copied` : t`Copy code`}
											</Button>
										)}
									</CopyButton>
								</Group>
							</Stack>
						) : null}
						<Button
							variant="subtle"
							size="xs"
							component="a"
							href={publicUrl}
							target="_blank"
							rel="noopener noreferrer"
							leftSection={<ArrowSquareOutIcon size={14} />}
							className="self-start"
							{...testId("popcorn-public-url")}
						>
							<Trans>Open the public page</Trans>
						</Button>
					</>
				) : null}
			</Stack>
		</Paper>
	);
}
