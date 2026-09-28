import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

export interface V2MeData {
	id: string | null;
	directus_user_id: string;
	email: string;
	display_name: string;
	avatar: string | null;
	onboarding_completed: boolean;
	orgs: Array<{
		id: string;
		name: string;
		role: string;
		is_partner?: boolean;
	}>;
	has_pending_invites: boolean;
	// Gates internal-only UI (workspace tier-set, future audit controls).
	// Derived from Directus Administrator role / JWT admin_access claim.
	is_staff: boolean;
	// True if the user has projects from before workspaces existed. Drives
	// the onboarding split: new users (false) see signup-time organisation name;
	// legacy users (true) see the migration screen copy.
	has_legacy_projects: boolean;
	// Post-register questionnaire answers (ISSUE-012). Null until submitted.
	// Drives whether the (required but non-blocking) questions step is shown.
	onboarding_answer_json: {
		version: string;
		data: Array<Record<string, unknown>>;
	} | null;
	// Training (ISSUE-020): per-user license status + the high-risk flag that,
	// with no active license, drives the non-blocking Inbox nudge (ISSUE-014).
		training_status?: {
			trained: boolean;
			trained_until: string | null;
			expiring_soon: boolean;
		};
		high_risk_context?: boolean;
		settings: Record<string, any>;
	}

async function fetchV2Me(): Promise<V2MeData | null> {
	const res = await fetch(`${API_BASE_URL}/v2/me`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

export const useV2Me = ({ enabled = true }: { enabled?: boolean } = {}) =>
	useQuery({
		enabled,
		queryFn: fetchV2Me,
		queryKey: ["v2", "me"],
		retry: false,
		staleTime: 60_000,
	});
