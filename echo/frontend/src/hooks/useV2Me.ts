import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

export interface V2MeData {
	id: string | null;
	directus_user_id: string;
	email: string;
	display_name: string;
	avatar: string | null;
	onboarding_completed: boolean;
	orgs: Array<{ id: string; name: string; role: string }>;
	has_pending_invites: boolean;
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
		queryKey: ["v2", "me"],
		queryFn: fetchV2Me,
		enabled,
		staleTime: 60_000,
		retry: false,
	});
