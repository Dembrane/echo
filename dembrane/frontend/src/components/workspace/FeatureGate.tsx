import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Stack, Text } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { type ReactNode, useEffect, useRef } from "react";
import {
	PricingConfigurator,
	usePricingConfigurator,
} from "@/components/pricing";
import { useWorkspace } from "@/hooks/useWorkspace";
import { emitFrozenFeatureAttempt } from "@/lib/frozenFeatureAttempt";
import { testId } from "@/lib/testUtils";
import { TIER_ORDER, type Tier } from "@/lib/tiers";
import { FeatureGatePopover } from "./FeatureGatePopover";
import { variantFor, type WallKey, wallPopoverLine } from "./gateWalls";
import { useGateViewed, usePricingGateEmitter } from "./pricingGateEvents";

/**
 * The tier gate.
 *
 * One modal, from all fifteen mount points, and it names no feature. The
 * feature is named one click earlier, in the popover on the blocked control.
 * The price table is gone: this path no longer sells a plan, it asks the
 * person what they need and ends in a booked call.
 *
 * The locked data family is the one exception. The transcription cap and the
 * locked conversation are about data the person already has, not a feature
 * they do not, so they open the modal directly with the cap line above the
 * free plan block. See `gateWalls.ts`.
 *
 * Exports:
 *   - <FeatureGate />  — the hatched placeholder for a whole feature surface.
 *     The card is the blocked control, so the card carries the popover.
 *   - <UpgradeModal /> — the one modal, usable standalone. Every wall that is
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
 * Wraps a feature card with a hatched placeholder when the tier does not meet
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
	const configurator = usePricingConfigurator();

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
				onStart={configurator.open}
				requiredTier={requiredTier}
				wallKey={wallKey}
				workspaceId={workspaceId}
			>
				{({ onClick }) => (
					<Box
						pos="relative"
						onClick={touched(onClick)}
						style={{
							alignItems: "center",
							// Soft hatched background — subtle, not alarming.
							background:
								"repeating-linear-gradient(45deg, rgba(65,105,225,0.04) 0 8px, rgba(65,105,225,0.08) 8px 16px)",
							borderRadius: 8,
							cursor: "pointer",
							display: "flex",
							justifyContent: "center",
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
						<Stack gap={6} align="center" style={{ maxWidth: 280 }} p="md">
							<Badge
								color="blue"
								variant="light"
								leftSection={<IconLock size={12} />}
							>
								<Trans>Available on a paid plan</Trans>
							</Badge>
							<Text size="sm" ta="center" fw={500}>
								{featureName}
							</Text>
						</Stack>
					</Box>
				)}
			</FeatureGatePopover>
			<UpgradeModal
				opened={configurator.opened}
				onClose={configurator.close}
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
	 * account with nothing to pay carries the configurator (`billing_page`),
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
	/** Transcription is billed to a project. Passed where the mount has one,
	 * so the voice answer works on the walls that sit inside a project. */
	projectId?: string;
}

/**
 * The one modal. Same content from every mount point.
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
	projectId,
	requiredTier,
	wallKey,
	workspaceId,
}: UpgradeModalProps) {
	const { workspace } = useWorkspace();
	const { i18n } = useLingui();
	const emit = usePricingGateEmitter(workspaceId);
	const gateViewed = useGateViewed(workspaceId);
	// One opening is one event. The old `upgrade_prompt_viewed` sat in a
	// `useEffect` whose deps held `currentTier`, which arrives from a query, so
	// it refired when the real tier landed. This ref is what stops that, and it
	// matters here too: the emitter's identity moves when the workspace query
	// settles.
	const viewedRef = useRef(false);
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

	return (
		<PricingConfigurator
			entry={entry}
			locale={i18n.locale}
			mount="app"
			onClose={onClose}
			onEvent={emit}
			opened={opened}
			orgId={workspace?.org_id}
			projectId={projectId}
			variant={variantFor(wallKey)}
			wallKey={wallKey}
			workspaceId={workspaceId || workspace?.id}
		/>
	);
}
