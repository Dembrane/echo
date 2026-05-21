import { Trans } from "@lingui/react/macro";
import { ActionIcon, Anchor, Group, Paper, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";

/**
 * Level-2 status banner for seat cap reached (unified — externals share
 * the same seat pool as members).
 *
 * Mounts in WorkspaceLayout alongside DowngradeBanner. Persistent strip
 * under the header until dismissed (per-session) or until the cap clears.
 */

const DISMISS_KEY_PREFIX = "dembrane_seatcap_banner_dismissed:";

interface UsageProbe {
	tier: string;
	seat_count: number;
	seat_count_included: number | null;
	external_count: number;
	seat_invite_blocked?: boolean;
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
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		staleTime: 60_000,
	});

	const seatCapHit =
		!!data &&
		data.seat_count_included != null &&
		data.seat_count >= data.seat_count_included;
	const blocked = data?.seat_invite_blocked ?? seatCapHit;

	const dismissKey = workspaceId
		? `${DISMISS_KEY_PREFIX}${workspaceId}`
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
	const seatLine = data
		? `${data.seat_count} / ${data.seat_count_included ?? "∞"}`
		: "";

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
						Workspace seats full on {tier}. {seatLine} seats used. Free a seat
						or upgrade to add more.
					</Trans>{" "}
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
