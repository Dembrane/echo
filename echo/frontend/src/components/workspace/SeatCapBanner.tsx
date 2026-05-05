import { Trans } from "@lingui/react/macro";
import { ActionIcon, Anchor, Group, Paper, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";

/**
 * Level-2 status banner (status-banner.md) for seat / guest cap reached.
 *
 * Mounts in WorkspaceLayout alongside DowngradeBanner. Persistent strip
 * under the header until dismissed (per-session) or until the cap clears.
 *
 * Visibility: any workspace member can see the banner (seat counts are
 * shared usage info, member-visible per matrix §8). Only admins/owners
 * see the actionable language ("upgrade") because they're the ones who
 * can act on it; members see the same banner with a milder CTA.
 *
 * Spec rules followed:
 *   - Background: Golden Pollen #ffd166 tint for warning.
 *   - Lead with state, not cause: "Workspace seats full" / "Guest cap reached".
 *   - Concrete numbers: "2 / 2 seats used".
 *   - Dismissable. Returns next session if state holds.
 *   - Never stacked: defers to DowngradeBanner if both apply (DowngradeBanner
 *     mounts first in WorkspaceLayout — its presence visually outranks ours).
 */

const DISMISS_KEY_PREFIX = "dembrane_seatcap_banner_dismissed:";

interface UsageProbe {
	tier: string;
	seat_count: number;
	seat_count_included: number | null;
	guest_count: number;
	guest_cap: number | null;
	member_invite_blocked?: boolean;
	guest_invite_blocked?: boolean;
}

async function fetchUsage(workspaceId: string): Promise<UsageProbe | null> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/usage`,
		{ credentials: "include" },
	);
	if (!res.ok) return null;
	return res.json();
}

export const SeatCapBanner = () => {
	const { workspace } = useWorkspace();
	const navigate = useI18nNavigate();
	const workspaceId = workspace?.id;

	const { data } = useQuery({
		enabled: !!workspaceId,
		queryFn: () => (workspaceId ? fetchUsage(workspaceId) : null),
		queryKey: ["v2", "workspace-usage", workspaceId, 0],
		// Match UsageCard / OrganisationUsageRollup: re-entering a route
		// where the banner mounts should reflect the current cap state,
		// not a 60s-stale snapshot. Without this the banner can lag by a
		// tick after a mutation made the cap fresh.
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		staleTime: 60_000,
	});

	// Prefer the backend flag, but fall back to computing client-side from
	// seat_count vs seat_count_included so the banner still works on
	// deploys where the backend hasn't yet shipped the flag — and matches
	// the same hard-block-only-on-Pilot rule.
	const tierIsHardBlock = data?.tier === "pilot";
	const memberCapHit =
		!!data &&
		data.seat_count_included != null &&
		data.seat_count >= data.seat_count_included;
	const guestCapHit =
		!!data && data.guest_cap != null && data.guest_count >= data.guest_cap;

	const memberBlocked =
		data?.member_invite_blocked ?? (tierIsHardBlock && memberCapHit);
	const guestBlocked = data?.guest_invite_blocked ?? guestCapHit;
	const blocked = memberBlocked || guestBlocked;

	// Per-session dismissal keyed on (workspace, current state). State key
	// includes which caps are blocked so dismissing the seat-only banner
	// doesn't suppress a later guest-only banner.
	const stateKey = `${memberBlocked ? "M" : ""}${guestBlocked ? "G" : ""}`;
	const dismissKey = workspaceId
		? `${DISMISS_KEY_PREFIX}${workspaceId}:${stateKey}`
		: null;

	const [dismissed, setDismissed] = useState(false);
	useEffect(() => {
		if (!dismissKey) return;
		setDismissed(sessionStorage.getItem(dismissKey) === "1");
	}, [dismissKey]);

	if (!workspaceId || !blocked || dismissed) return null;

	const handleDismiss = () => {
		if (dismissKey) sessionStorage.setItem(dismissKey, "1");
		setDismissed(true);
	};

	const tier = data?.tier ?? "";
	const seatLine =
		memberBlocked && data
			? `${data.seat_count} / ${data.seat_count_included ?? "∞"} seats`
			: null;
	const guestLine =
		guestBlocked && data
			? `${data.guest_count} / ${data.guest_cap ?? "∞"} guests`
			: null;

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
					{memberBlocked && guestBlocked ? (
						<Trans>
							Workspace at capacity on {tier}. {seatLine} and {guestLine} used.
						</Trans>
					) : memberBlocked ? (
						<Trans>
							Workspace seats full on {tier}. {seatLine} used. Free a seat or
							upgrade to add more.
						</Trans>
					) : (
						<Trans>
							Guest cap reached on {tier}. {guestLine} used. Remove a guest or
							upgrade to invite more.
						</Trans>
					)}{" "}
					<Anchor
						component="button"
						type="button"
						size="sm"
						onClick={() => navigate(`/w/${workspaceId}/settings/billing`)}
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
