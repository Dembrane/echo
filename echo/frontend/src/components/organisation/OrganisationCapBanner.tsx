import { Plural, Trans } from "@lingui/react/macro";
import { ActionIcon, Anchor, Group, Paper, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

interface WorkspaceCapInfo {
	id: string;
	name: string;
	tier: string;
	member_count: number;
	member_invite_blocked?: boolean;
	guest_invite_blocked?: boolean;
}

interface Props {
	organisationId: string;
	workspaces: WorkspaceCapInfo[];
}

const DISMISS_KEY_PREFIX = "dembrane_orgcap_banner_dismissed:";

/**
 * Level-2 status banner for org-scoped cap state (status-banner.md).
 *
 * Renders when one or more workspaces in the organisation have hit a
 * member or guest cap. Persistent strip under the header on every
 * /o/:organisationId/* route until dismissed (per-session).
 *
 * Why org-level: an organisation admin might be on the People tab adding
 * someone and not realise that one of their workspaces is full —
 * pre-warn them before they pick a frozen workspace card. The
 * workspace cards in the invite wizard already disable individually,
 * but the banner gives a route-level "heads up something needs your
 * attention."
 */
export const OrganisationCapBanner = ({
	organisationId,
	workspaces,
}: Props) => {
	const navigate = useI18nNavigate();

	const blockedWorkspaces = workspaces.filter(
		(w) => w.member_invite_blocked || w.guest_invite_blocked,
	);

	// Per-session dismissal keyed on org + the set of blocked workspaces +
	// their cap state. If a new workspace fills up later, the key changes
	// and the banner returns.
	const stateKey = blockedWorkspaces
		.map(
			(w) =>
				`${w.id}:${w.member_invite_blocked ? "M" : ""}${w.guest_invite_blocked ? "G" : ""}`,
		)
		.join("|");
	const dismissKey = `${DISMISS_KEY_PREFIX}${organisationId}:${stateKey}`;

	const [dismissed, setDismissed] = useState(false);
	useEffect(() => {
		setDismissed(sessionStorage.getItem(dismissKey) === "1");
	}, [dismissKey]);

	if (blockedWorkspaces.length === 0 || dismissed) return null;

	const handleDismiss = () => {
		sessionStorage.setItem(dismissKey, "1");
		setDismissed(true);
	};

	const first = blockedWorkspaces[0];
	const others = blockedWorkspaces.length - 1;

	return (
		<Paper
			radius={0}
			p="sm"
			style={{
				background: "#ffd16633",
				borderBottom: "1px solid #d6b152",
				marginBottom: 16,
			}}
		>
			<Group justify="space-between" wrap="nowrap" gap="sm">
				<Text size="sm">
					{others === 0 ? (
						<Trans>
							"{first.name}" is at capacity on {first.tier}. New invites to that
							workspace are blocked.
						</Trans>
					) : (
						<Trans>
							"{first.name}" and{" "}
							<Plural
								value={others}
								one="# other workspace"
								other="# other workspaces"
							/>{" "}
							are at capacity. New invites to those workspaces are blocked.
						</Trans>
					)}{" "}
					<Anchor
						component="button"
						type="button"
						size="sm"
						onClick={() => navigate(`/w/${first.id}/settings/billing`)}
					>
						<Trans>See usage</Trans>
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
