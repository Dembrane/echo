import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { ArrowSquareOutIcon, LockIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { newConfigSessionId } from "@/components/pricing/configuratorState";
import { saveHandover } from "@/components/pricing/submitConfiguration";
import { useWorkspace } from "@/hooks/useWorkspace";
import { emitFrozenFeatureAttempt } from "@/lib/frozenFeatureAttempt";
import { pricingHandoverUrl } from "@/lib/links";
import { testId } from "@/lib/testUtils";
import { TIER_ORDER, type Tier } from "@/lib/tiers";
import { FeatureGatePopover } from "./FeatureGatePopover";
import {
	isLockedDataWall,
	type WallKey,
	wallHandoverTitle,
	wallPopoverLine,
} from "./gateWalls";
import { useGateViewed, usePricingGateEmitter } from "./pricingGateEvents";

/**
 * The tier gate.
 *
 * One prompt, from every mount point: a single screen that says what the
 * person just ran into and offers to continue on the dembrane website, where
 * the pricing calculator learns how they use dembrane and a call can be
 * booked. No price and no questions here. Nobody is sent away without
 * choosing it.
 *
 * The locked data family is the one exception to the popover. The
 * transcription cap is about data the person already has, not a feature they
 * do not, so it opens the prompt directly and the prompt says nothing was
 * lost. See `gateWalls.ts`.
 *
 * Exports:
 *   - <FeatureGate />  — the placeholder for a whole feature surface.
 *     The card is the blocked control, so the card carries the popover.
 *   - <UpgradeModal /> — the one prompt, usable standalone. Every wall that is
 *     met by doing something (a cap reached mid action) opens this directly.
 *
 * What this path no longer renders:
 *   - the tier price cards and the billing period toggle. No price appears on
 *     the gate path at all.
 *   - every tier name in gate copy. "Available on a paid plan", never a
 *     specific tier, because a tier name the person cannot buy sends them
 *     looking for a price this path does not show.
 *   - the "ask a organisation admin" member path. The action is a booked call
 *     now, and a member can book one. `can_request_upgrade` still rides on
 *     `pricing_config_gate_viewed`.
 *   - the EU AI Act training footnote, which linked to the public pricing
 *     page.
 */

interface FeatureGateProps {
	/** Currently-resolved workspace tier. */
	currentTier: Tier;
	/** Minimum tier the wrapped feature requires. */
	requiredTier: Tier;
	/** Which wall this is. Stable, never translated, required at every mount. */
	wallKey: WallKey;
	/** The control's own label, e.g. "Webhooks". Not gate copy. */
	featureName: string;
	/** `true` if the caller has admin/owner role in this workspace. */
	canRequestUpgrade: boolean;
	/** Workspace id for the events and the durable row. */
	workspaceId: string;
	/** The gated feature's normal render — shown once the tier meets. */
	children: ReactNode;
}

function meetsTier(current: Tier, required: Tier): boolean {
	const requiredIndex = TIER_ORDER.indexOf(required);
	// A tier nobody knows is never "already met". `UploadLockedCard` falls back
	// to "pioneer", which is not in the order, and the old arithmetic made that
	// read as met by everyone. That was harmless while nothing acted on it. It
	// is not harmless now: R5 suppresses a gate whose tier is already held, so
	// an unknown requirement would close the upload wall for everybody.
	if (requiredIndex < 0) return false;
	return TIER_ORDER.indexOf(current) >= requiredIndex;
}

/**
 * Wraps a feature card with a placeholder when the tier does not meet
 * the minimum. If the tier is already met, renders children as-is.
 */
export function FeatureGate({
	canRequestUpgrade,
	children,
	currentTier,
	featureName,
	requiredTier,
	wallKey,
	workspaceId,
}: FeatureGateProps) {
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);

	if (meetsTier(currentTier, requiredTier)) {
		return <>{children}</>;
	}

	// Deliberately do NOT render children when gated. `pointer-events: none`
	// was a tempting dimming trick but doesn't stop keyboard-level event
	// listeners, async code paths, or focus-trap components inside the
	// gated subtree (round-2 audit, Security M1). The only safe boundary
	// is "don't mount the feature at all when the tier doesn't meet" —
	// render just the gate placeholder card.
	// Matrix §3: attempting a frozen feature re-shows the post-downgrade
	// banner if it was dismissed. It fires when the blocked control is
	// touched, not when the modal opens, because touching the control IS the
	// attempt and the popover now sits between the two. DowngradeBanner only
	// reacts when the current workspace has an active downgrade, so this is a
	// cheap no-op on never-downgraded workspaces.
	const touched = (open: () => void) => () => {
		emitFrozenFeatureAttempt();
		open();
	};

	return (
		<>
			<FeatureGatePopover
				canRequestUpgrade={canRequestUpgrade}
				onStart={upgradeHandlers.open}
				requiredTier={requiredTier}
				wallKey={wallKey}
				workspaceId={workspaceId}
			>
				{({ onClick }) => (
					<Box
						pos="relative"
						className="app-do"
						onClick={touched(onClick)}
						style={{
							alignItems: "center",
							display: "flex",
							minHeight: 160,
						}}
						role="button"
						tabIndex={0}
						aria-label={featureName}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								touched(onClick)();
							}
						}}
						{...testId("feature-gate-card")}
					>
						<Stack gap="xs" align="flex-start" style={{ maxWidth: 280 }} p="md">
							<Badge
								color="blue"
								variant="light"
								leftSection={<LockIcon size={16} />}
							>
								<Trans>Available on a paid plan</Trans>
							</Badge>
							<Text size="sm">{featureName}</Text>
						</Stack>
					</Box>
				)}
			</FeatureGatePopover>
			<UpgradeModal
				opened={upgradeOpened}
				onClose={upgradeHandlers.close}
				currentTier={currentTier}
				requiredTier={requiredTier}
				wallKey={wallKey}
				canRequestUpgrade={canRequestUpgrade}
				workspaceId={workspaceId}
				entry={wallPopoverLine(wallKey) ? "popover_link" : "modal_direct"}
			/>
		</>
	);
}

interface UpgradeModalProps {
	opened: boolean;
	onClose: () => void;
	currentTier: Tier;
	/**
	 * The tier this wall needs, where there is one.
	 *
	 * `null` on an entry point that is not a wall. The billing page of an
	 * account with nothing to pay carries the upgrade prompt (`billing_page`),
	 * and nothing there is blocked, so there is no tier to already hold and
	 * R5's suppression below must not fire. Every real wall passes a tier.
	 */
	requiredTier: Tier | null;
	/** `true` if the caller has admin/owner role in this workspace. */
	canRequestUpgrade: boolean;
	workspaceId: string;
	/** Which wall opened this. Required at every mount: a mount that cannot
	 * name its wall leaves the denominator. */
	wallKey: WallKey;
	/** `popover_link` when a popover named the feature first, so
	 * `pricing_config_gate_viewed` already fired there. `modal_direct` when
	 * this is the first surface the person meets. */
	entry?: "popover_link" | "modal_direct";
	/** Recorded on the handover row, so whoever follows up sees where it came
	 * from. Passed where the mount has one. */
	projectId?: string;
	/** The org the upgrade is for, when it is not the active workspace's. */
	orgId?: string;
}

/**
 * The one prompt. Same from every mount point; only the title follows the
 * wall.
 *
 * "Continue on dembrane.com" is a plain link opened by the person's own click,
 * so no browser blocks the tab. The same click saves a row for the signed-in
 * account (the server takes the email from the session) and puts only that
 * row's random id in the address, so the website can link what the person
 * plans there back to their account without being told who they are. Each
 * opening is a new id: one handover, one row.
 *
 * A gate must never offer a tier the account already holds. That happened
 * before: gates told accounts to upgrade to the tier they were already on,
 * and in one case to a lower one. So a gate whose required tier is already
 * met renders nothing and emits nothing.
 */
export function UpgradeModal({
	canRequestUpgrade,
	currentTier,
	entry = "modal_direct",
	onClose,
	opened,
	orgId,
	projectId,
	requiredTier,
	wallKey,
	workspaceId,
}: UpgradeModalProps) {
	const { i18n } = useLingui();
	const { workspace } = useWorkspace();
	const gateViewed = useGateViewed(workspaceId);
	const emit = usePricingGateEmitter(workspaceId);
	// One opening is one event. The old `upgrade_prompt_viewed` sat in a
	// `useEffect` whose deps held `currentTier`, which arrives from a query, so
	// it refired when the real tier landed. This ref is what stops that, and it
	// matters here too: the emitter's identity moves when the workspace query
	// settles.
	const viewedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a fresh id per opening is the point
	const handover = useMemo(() => newConfigSessionId(), [opened]);
	const url = pricingHandoverUrl({
		back: window.location.origin,
		handover,
		language: i18n.locale,
		trigger: wallKey,
	});
	// No required tier means no wall, so there is nothing the person can
	// already hold. See the prop.
	const alreadyHas =
		requiredTier !== null && meetsTier(currentTier, requiredTier);

	useEffect(() => {
		if (!opened || alreadyHas || viewedRef.current) return;
		// The popover is the first surface where there is one, and it already
		// fired the event. Firing again here would count one encounter twice.
		if (entry !== "modal_direct") return;
		viewedRef.current = true;
		gateViewed({
			canRequestUpgrade,
			// The event property is a string, and "none" says out loud that this
			// entry point had no tier requirement. An empty value would read as a
			// mount that forgot to name one.
			requiredTier: requiredTier ?? "none",
			surface: "modal",
			wallKey,
		});
	}, [
		alreadyHas,
		canRequestUpgrade,
		entry,
		gateViewed,
		opened,
		requiredTier,
		wallKey,
	]);

	if (alreadyHas) return null;

	const continueOnSite = () => {
		emit("pricing_config_handover_continued", {
			config_session_id: handover,
			mount: "app",
			wall_key: wallKey,
		});
		// The tab is already open by now; a failed save costs only the link to
		// the account, never the person's way forward.
		saveHandover({
			config_session_id: handover,
			locale: i18n.locale,
			org_id: orgId ?? workspace?.org_id,
			project_id: projectId,
			wall_key: wallKey,
			workspace_id: workspaceId || workspace?.id,
		}).catch(() => {});
		onClose();
	};

	const later = () => {
		emit("pricing_config_handover_dismissed", {
			mount: "app",
			wall_key: wallKey,
		});
		onClose();
	};

	return (
		<Modal
			opened={opened}
			onClose={later}
			centered
			size="md"
			title={wallHandoverTitle(wallKey)}
			{...testId("upgrade-modal")}
		>
			<Stack gap="md">
				<Text {...testId("upgrade-modal-body")}>
					<Trans>
						We'd love to learn a bit about how you use dembrane, so we can help
						you better. It takes about two minutes on our website, and you can
						book a short call with us at the end if you like.
					</Trans>
				</Text>
				<Text size="sm" c="dimmed" {...testId("upgrade-modal-reassurance")}>
					{isLockedDataWall(wallKey) ? (
						<Trans>
							Your portals keep working and nothing your participants say is
							lost. Once you're on a paid plan, transcription catches up on
							everything already recorded.
						</Trans>
					) : (
						<Trans>Everything you've made here stays as it is.</Trans>
					)}
				</Text>
				<Group gap="sm" mt="xs">
					<Button
						component="a"
						variant="filled"
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						onClick={continueOnSite}
						rightSection={<ArrowSquareOutIcon size={16} />}
						{...testId("upgrade-modal-continue")}
					>
						<Trans>Continue on dembrane.com</Trans>
					</Button>
					<Button
						variant="subtle"
						onClick={later}
						{...testId("upgrade-modal-later")}
					>
						<Trans>Maybe later</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
