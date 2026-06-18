import { t } from "@lingui/core/macro";
import { useMemo } from "react";
import { useV2Me } from "@/hooks/useV2Me";

/**
 * A non-blocking Inbox pending action. Sources are ADDITIVE: each wave that
 * needs a pending action contributes one to this list (e.g. Wave B's
 * failed-charge action), and the Inbox count compounds them. Never hardcode a
 * single count or overwrite the list.
 */
export interface PendingAction {
	code: string;
	title: string;
	message: string;
	/** Where the "act on it" CTA goes (locale-prefixed at render time). */
	href: string;
}

/**
 * High-risk training nudge (ISSUE-014). Surfaces when the user flagged a
 * high-risk context during onboarding AND holds no active training license.
 * Warns, never blocks. Dormant until the backend high-risk selector is wired
 * to Wave D's onboarding answer (it returns False today, so this stays empty).
 */
export const useTrainingPendingActions = (): PendingAction[] => {
	const { data: me } = useV2Me();

	return useMemo(() => {
		if (!me) return [];
		const trained = me.training_status?.trained ?? false;
		if (!me.high_risk_context || trained) return [];

		// Point at the user's first org Training view; fall back to the org list.
		const orgId = me.orgs?.[0]?.id;
		const href = orgId ? `/o/${orgId}/training` : "/o";
		return [
			{
				code: "training_required_high_risk",
				href,
				message: t`Book a certified training to keep using dembrane in high-risk settings.`,
				title: t`Training required for high-risk use`,
			},
		];
	}, [me]);
};

/**
 * Compounds every pending-action source into a single Inbox count. Additive —
 * extend the spread as more sources land.
 */
export const usePendingActionCount = (): number => {
	const training = useTrainingPendingActions();
	return training.length;
};
