import { Trans } from "@lingui/react/macro";
import { ActionIcon, Anchor, Group, Paper, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { onFrozenFeatureAttempt } from "@/lib/frozenFeatureAttempt";

/**
 * 7-day post-downgrade banner (matrix v1.1 §3).
 *
 * Reads `workspace.downgraded_at` + `downgraded_from_tier` from the
 * workspace summary. Renders for 7 days past the stamp.
 *
 * Dismissable per-session. Matrix spec says it auto-returns on frozen-
 * feature-attempt — that's a follow-up (FeatureGate would need to fire a
 * signal here). For this first pass, dismissal is simple session-local.
 */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISS_KEY_PREFIX = "dembrane_downgrade_banner_dismissed:";

export const DowngradeBanner = () => {
	const { workspace } = useWorkspace();
	const navigate = useI18nNavigate();
	const downgradedAt = workspace?.downgraded_at;
	const tier = workspace?.tier;
	const workspaceId = workspace?.id;

	const [dismissed, setDismissed] = useState(false);

	useEffect(() => {
		if (!workspaceId || !downgradedAt) return;
		const stored = sessionStorage.getItem(
			`${DISMISS_KEY_PREFIX}${workspaceId}:${downgradedAt}`,
		);
		setDismissed(stored === "1");
	}, [workspaceId, downgradedAt]);

	// Matrix §3: auto-return on frozen-feature-attempt. When FeatureGate
	// opens its tier modal, clear the dismissal so this banner comes back.
	// No-op for workspaces without an active downgrade — the outer early-
	// returns guard that path.
	useEffect(() => {
		if (!workspaceId || !downgradedAt) return;
		return onFrozenFeatureAttempt(() => {
			sessionStorage.removeItem(
				`${DISMISS_KEY_PREFIX}${workspaceId}:${downgradedAt}`,
			);
			setDismissed(false);
		});
	}, [workspaceId, downgradedAt]);

	if (!workspace || !downgradedAt || !tier || !workspaceId) return null;

	const stamp = Date.parse(downgradedAt);
	if (Number.isNaN(stamp)) return null;

	const now = Date.now();
	if (now - stamp > SEVEN_DAYS_MS) return null;
	if (dismissed) return null;

	const sinceDate = new Date(stamp).toLocaleDateString(undefined, {
		day: "numeric",
		month: "long",
		year: "numeric",
	});

	const handleDismiss = () => {
		sessionStorage.setItem(
			`${DISMISS_KEY_PREFIX}${workspaceId}:${downgradedAt}`,
			"1",
		);
		setDismissed(true);
	};

	return (
		<Paper
			radius={0}
			p="sm"
			style={{
				background: "#ffd16633",
				borderBottom: "1px solid #d6b152",
			}}
		>
			<Group justify="space-between" wrap="nowrap" gap="sm">
				<Text size="sm">
					<Trans>
						This workspace was downgraded to {tier} on {sinceDate}. Some
						features are limited.
					</Trans>{" "}
					<Anchor
						component="button"
						type="button"
						size="sm"
						onClick={() => navigate(`/w/${workspaceId}/settings/billing`)}
					>
						<Trans>Learn more</Trans>
					</Anchor>
				</Text>
				<ActionIcon
					variant="subtle"
					size="sm"
					color="dark"
					onClick={handleDismiss}
					aria-label="Dismiss"
				>
					<IconX size={14} />
				</ActionIcon>
			</Group>
		</Paper>
	);
};
