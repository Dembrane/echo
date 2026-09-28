import { Trans } from "@lingui/react/macro";
import { Anchor, Stack, Text, Title } from "@mantine/core";
import styles from "./PilotHistory.module.css";

/** Separate repository and version history, not another release in this feed. */
export const PilotHistory = () => (
	<section className={styles.history} aria-labelledby="pilot-history-title">
		<Stack gap="sm">
			<Text size="sm">2024</Text>
			<Title order={2} size="lg" fw={400} id="pilot-history-title">
				<Trans>Before this release history</Trans>
			</Title>
			<Text size="sm">
				<Trans>
					dembrane/pilot was our earlier project. Thank you to the hosts,
					participants and contributors who helped shape it.
				</Trans>
			</Text>
			<ul className={styles.highlights}>
				<li>
					<Trans>A participant portal for recording conversations.</Trans>
				</li>
				<li>
					<Trans>Text contributions and follow-up forms.</Trans>
				</li>
				<li>
					<Trans>Project and conversation search, with branded QR codes.</Trans>
				</li>
				<li>
					<Trans>Chat with individual conversations.</Trans>
				</li>
			</ul>
			<Anchor
				href="https://github.com/Dembrane/pilot/releases"
				target="_blank"
				rel="noopener noreferrer"
				size="sm"
			>
				<Trans>Explore the dembrane/pilot archive</Trans>
			</Anchor>
		</Stack>
	</section>
);
