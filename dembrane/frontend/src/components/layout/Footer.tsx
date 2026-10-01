import { Trans } from "@lingui/react/macro";
import { Anchor, Group, Stack, Text } from "@mantine/core";
import {
	LEGAL_DPA_URL,
	LEGAL_PRIVACY_URL,
	LEGAL_TERMS_URL,
	PREVIEW_PR,
} from "@/config";

// PR previews only: which pull request this deployment was built from.
const PreviewLine = ({ number, url }: { number: number; url: string }) => (
	<Anchor
		size="xs"
		c="dimmed"
		target="_blank"
		rel="noreferrer"
		href={url}
		data-testid="footer-preview-pr"
	>
		<Trans>Preview of PR #{number}</Trans>
	</Anchor>
);

export const Footer = () => (
	<Stack gap="xs" justify="center" align="center">
		<Group gap="lg">
			<Anchor size="sm" target="_blank" href={LEGAL_TERMS_URL}>
				<Trans>Terms</Trans>
			</Anchor>
			<Anchor size="sm" target="_blank" href={LEGAL_PRIVACY_URL}>
				<Trans>Privacy</Trans>
			</Anchor>
			<Anchor size="sm" target="_blank" href={LEGAL_DPA_URL}>
				<Trans>DPA</Trans>
			</Anchor>
		</Group>
		<Text size="sm">
			<Trans>
				dembrane B.V. {new Date().getFullYear()}, all rights reserved.
			</Trans>
		</Text>
		{PREVIEW_PR && <PreviewLine {...PREVIEW_PR} />}
	</Stack>
);
