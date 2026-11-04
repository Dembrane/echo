import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Button, Modal, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { LockIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { emitFrozenFeatureAttempt } from "@/lib/frozenFeatureAttempt";
import { pricingCalculatorUrl } from "@/lib/links";
import { testId } from "@/lib/testUtils";
import { TIER_ORDER, type Tier } from "@/lib/tiers";
import { FeatureGatePopover } from "./FeatureGatePopover";
import { type WallKey, wallPopoverLine } from "./gateWalls";
import { useGateViewed } from "./pricingGateEvents";

/**
 * The tier gate.
 *
 * One prompt, from all fifteen mount points, and it names no feature. The
 * feature is named one click earlier, in the popover on the blocked control.
 * No price appears here: planning a paid account and booking the call happen
 * in the pricing calculator on the dembrane website, which the prompt opens in
 * a new tab.
 *
 * The locked data family is the one exception. The transcription cap and the
 * locked conversation are about data the person already has, not a feature
 * they do not, so they open the prompt directly, without a popover first. See
 * `gateWalls.ts`.
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
	/** Not read since the calculator moved to the website. Kept so the mounts
	 * that pass them need no change. */
	projectId?: string;
	orgId?: string;
}

/**
 * The one prompt. Same from every mount point.
 *
 * Opening it sends the person to the pricing calculator on the website, in a
 * new tab, and closes it again. That happens in the same click as the one that
 * opened it, so the browser allows the tab. When a wall opens after a request
 * has answered (a cap reached mid action) a browser may refuse the tab, and the
 * modal then stays up with a link that cannot be refused.
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
	requiredTier,
	wallKey,
	workspaceId,
}: UpgradeModalProps) {
	const { i18n } = useLingui();
	const gateViewed = useGateViewed(workspaceId);
	// One opening is one event. The old `upgrade_prompt_viewed` sat in a
	// `useEffect` whose deps held `currentTier`, which arrives from a query, so
	// it refired when the real tier landed. This ref is what stops that, and it
	// matters here too: the emitter's identity moves when the workspace query
	// settles.
	const viewedRef = useRef(false);
	// One opening is one tab, also under StrictMode's second effect run.
	const redirectedRef = useRef(false);
	const [refused, setRefused] = useState(false);
	const url = pricingCalculatorUrl(i18n.locale);
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

	useEffect(() => {
		if (!opened) {
			redirectedRef.current = false;
			setRefused(false);
			return;
		}
		if (alreadyHas || redirectedRef.current) return;
		redirectedRef.current = true;
		const tab = window.open(url, "_blank");
		if (tab) {
			tab.opener = null;
			onClose();
		} else {
			setRefused(true);
		}
	}, [alreadyHas, onClose, opened, url]);

	if (alreadyHas) return null;

	return (
		<Modal
			opened={opened && refused}
			onClose={onClose}
			centered
			size="sm"
			withCloseButton
			{...testId("upgrade-modal")}
		>
			<Button
				component="a"
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				fullWidth
				onClick={onClose}
				{...testId("upgrade-modal-link")}
			>
				<Trans>Tell us what you need</Trans>
			</Button>
		</Modal>
	);
}
