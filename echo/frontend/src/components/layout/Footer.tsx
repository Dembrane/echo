import { Trans } from "@lingui/react/macro";
import { Anchor, Group, Stack, Text } from "@mantine/core";
import { LEGAL_DPA_URL, LEGAL_PRIVACY_URL, LEGAL_TERMS_URL } from "@/config";

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
			dembrane B.V. {new Date().getFullYear()}, all rights reserved.
		</Text>
	</Stack>
);
