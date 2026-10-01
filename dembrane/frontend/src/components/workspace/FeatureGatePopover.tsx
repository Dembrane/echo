import { Trans } from "@lingui/react/macro";
import { Anchor, Popover, Stack, Text } from "@mantine/core";
import { type ReactElement, useCallback, useRef, useState } from "react";
import { testId } from "@/lib/testUtils";
import { type WallKey, wallPopoverLine } from "./gateWalls";
import { useGateViewed } from "./pricingGateEvents";

/**
 * The popover on the blocked control.
 *
 * The feature is named here and nowhere else. Every mount point opens the same
 * modal, and the modal names nothing, because this named it one click earlier.
 *
 * A popover, not a tooltip. A tooltip makes people steer the mouse into a
 * shape that keeps vanishing, and it never reaches a keyboard or a touch
 * screen. This opens on click, stays open, and the link inside it can be
 * reached.
 *
 * Built on Mantine's `Popover` rather than the native `popover` attribute.
 * Native popovers land in the top layer with no position of their own:
 * placing one beside its control needs CSS anchor positioning,
 * which does not carry across the browsers this app supports. Mantine is
 * already a dependency, it positions against the control, and `withRoles`
 * gives the control `aria-haspopup`, `aria-expanded` and `aria-controls` while
 * the dropdown gets `role="dialog"`. Escape and a click outside both close it.
 *
 * `pricing_config_gate_viewed` fires HERE, not on the modal. This is the first
 * surface the person meets, so it is the denominator the funnel needs. A
 * denominator on the modal would drop everyone who read this and stopped, and
 * the rate would rise for the wrong reason.
 */

type FeatureGatePopoverProps = {
	wallKey: WallKey;
	requiredTier: string;
	canRequestUpgrade: boolean;
	workspaceId?: string;
	/** Opens the configurator. The gate owns the modal. */
	onStart: () => void;
	/** The blocked control. It gets the click that opens the popover. */
	children: (trigger: { onClick: () => void }) => ReactElement;
};

export function FeatureGatePopover({
	canRequestUpgrade,
	children,
	onStart,
	requiredTier,
	wallKey,
	workspaceId,
}: FeatureGatePopoverProps) {
	const [opened, setOpened] = useState(false);
	const gateViewed = useGateViewed(workspaceId);
	// One encounter is one event. The old `upgrade_prompt_viewed` refired
	// whenever the tier query resolved, so one encounter produced several
	// events.
	const viewedRef = useRef(false);
	const line = wallPopoverLine(wallKey);

	const toggle = useCallback(() => {
		setOpened((previous) => {
			const next = !previous;
			if (next && !viewedRef.current) {
				viewedRef.current = true;
				gateViewed({
					canRequestUpgrade,
					requiredTier,
					surface: "popover",
					wallKey,
				});
			}
			return next;
		});
	}, [canRequestUpgrade, gateViewed, requiredTier, wallKey]);

	// No agreed line for this wall, so there is nothing to say here. The control
	// opens the modal directly and the gate reports `surface="modal"`.
	if (!line) {
		return children({ onClick: onStart });
	}

	return (
		<Popover
			opened={opened}
			onChange={setOpened}
			position="bottom"
			shadow="md"
			trapFocus
			// It opens at once. A fade on a gate reads as a delay, and Mantine's
			// default transition never mounts the dropdown under jsdom, so the
			// surface could not be tested at all with it on.
			transitionProps={{ duration: 0 }}
			// Escape closes it and the focus goes back to the control it opened
			// from. Without this the focus lands on the body, so the next Tab
			// starts the page again and the keyboard loses its place.
			returnFocus
			width={330}
			withArrow
			withinPortal
		>
			<Popover.Target>{children({ onClick: toggle })}</Popover.Target>
			<Popover.Dropdown {...testId("feature-gate-popover")}>
				<Stack gap={8} align="flex-start">
					<Text size="sm">{line}</Text>
					<Anchor
						component="button"
						type="button"
						size="sm"
						onClick={() => {
							setOpened(false);
							onStart();
						}}
						{...testId("feature-gate-popover-start")}
					>
						<Trans>Tell us what you need</Trans>
					</Anchor>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}
