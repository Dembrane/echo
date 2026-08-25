import { useLingui } from "@lingui/react";
import posthog from "posthog-js";
import { useCallback, useMemo } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { useWorkspace } from "@/hooks/useWorkspace";
import type { WallKey } from "./gateWalls";

/**
 * The account side of every pricing configurator event.
 *
 * The configurator adds `config_session_id`, `question_set_version`, `mount`
 * and `wall_key` itself. It knows nothing about the account, so this merges
 * the rest and does the capture.
 *
 * `is_internal` comes from the account's own email domain, the same rule the
 * server uses (`admin_managed.py`). It is set at write time and never guessed
 * later, so internal traffic cannot be mistaken for a real account after the
 * fact.
 *
 * No `user_id` and no `email` on any event. The durable row carries the
 * identity; analytics does not need it.
 *
 * This hook covers what the gate itself emits.
 */

const INTERNAL_EMAIL_DOMAIN = "@dembrane.com";

export type PricingGateEmitter = (
	name: string,
	props?: Record<string, unknown>,
) => void;

export function usePricingGateBase(workspaceId?: string) {
	const { workspace } = useWorkspace();
	const { i18n } = useLingui();
	const { data: user } = useCurrentUser();
	const email = (user?.email as string | undefined) ?? "";

	return useMemo(
		() => ({
			is_internal: email.toLowerCase().endsWith(INTERNAL_EMAIL_DOMAIN),
			locale: i18n.locale,
			org_id: workspace?.org_id,
			tier: workspace?.tier ?? "free",
			workspace_id: workspaceId || workspace?.id,
		}),
		[email, i18n.locale, workspace, workspaceId],
	);
}

/**
 * Hands back the emitter the gate passes to the configurator as `onEvent`, so
 * every configurator event carries the account side too.
 */
export function usePricingGateEmitter(
	workspaceId?: string,
): PricingGateEmitter {
	const base = usePricingGateBase(workspaceId);

	return useCallback(
		(name: string, props: Record<string, unknown> = {}) => {
			posthog.capture(name, { ...base, ...props });
		},
		[base],
	);
}

/**
 * `pricing_config_gate_viewed`, the denominator for every rate in R16.
 *
 * It fires on the FIRST surface the person meets: the popover where there is
 * one, the modal where there is none. If it sat on the modal instead, every
 * person who read the popover and stopped would leave the count, the rate
 * would rise, and the change would take credit it had not earned. That is the
 * PR #900 failure, and R15 exists to stop it.
 *
 * The caller guards the call with a ref so one encounter is one event. The old
 * `upgrade_prompt_viewed` did not: its `useEffect` held `currentTier`, which
 * arrives from a query, so the effect ran again when the real tier landed.
 */
export type GateViewedProps = {
	wallKey: WallKey;
	surface: "popover" | "modal";
	requiredTier: string;
	canRequestUpgrade: boolean;
};

export function useGateViewed(workspaceId?: string) {
	const base = usePricingGateBase(workspaceId);

	return useCallback(
		({
			wallKey,
			surface,
			requiredTier,
			canRequestUpgrade,
		}: GateViewedProps) => {
			posthog.capture("pricing_config_gate_viewed", {
				...base,
				can_request_upgrade: canRequestUpgrade,
				mount: "app",
				required_tier: requiredTier,
				surface,
				wall_key: wallKey,
			});
		},
		[base],
	);
}
