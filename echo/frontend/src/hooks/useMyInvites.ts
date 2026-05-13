import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";

export interface MyPendingInvite {
	id: string;
	workspace_id: string;
	workspace_name: string;
	org_name: string;
	role: string;
	invited_by_name: string | null;
	created_at: string | null;
	expires_at: string | null;
}

async function fetchMyInvites(): Promise<MyPendingInvite[]> {
	const res = await fetch(`${API_BASE_URL}/v2/me/invites`, {
		credentials: "include",
	});
	// Throw rather than [] — empty list is indistinguishable from "no invites".
	if (!res.ok) {
		throw new Error(`Invites request failed (${res.status})`);
	}
	return res.json();
}

export const useMyInvites = ({ enabled = true }: { enabled?: boolean } = {}) =>
	useQuery({
		enabled,
		queryFn: fetchMyInvites,
		queryKey: ["v2", "me", "invites"],
		staleTime: 30_000,
	});

export const useAcceptInvite = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (inviteId: string) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/me/invites/${inviteId}/accept`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const err = new Error(data.detail || "Failed to accept invite");
				// Plumb status so callers can branch on 402 (cap reached)
				// without parsing the message — keeps UI tone i18n-safe.
				(err as Error & { status?: number }).status = res.status;
				throw err;
			}
			return res.json() as Promise<{ workspace_id: string }>;
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
		},
	});
};

export const useDeclineInvite = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (inviteId: string) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/me/invites/${inviteId}/decline`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || "Failed to decline invite");
			}
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
		},
	});
};

// success = fresh accept; already_member = no-op (row + membership both
// existed); healed = row accepted but membership was missing (rare race) —
// treat visually as already_member.
export type AcceptInviteResult = {
	status?: "success" | "already_member" | "healed";
	workspace_id: string;
	workspace_name: string;
};

// Read-only inspect (does not consume). `is_member` is only meaningful
// when status is `pending` or `accepted`.
export type InviteByHashState = {
	status:
		| "pending"
		| "accepted"
		| "expired"
		| "workspace_deleted"
		| "not_found";
	workspace_id?: string;
	workspace_name?: string;
	role?: string;
	is_member?: boolean;
	expires_at?: string;
};

// Public probe used by the unauthenticated invite landing — without
// this, dead hashes fall through into register → stray personal org.
// No is_member field; there's no session to compare against.
export type PublicInviteStatus = {
	status:
		| "pending"
		| "accepted"
		| "expired"
		| "workspace_deleted"
		| "not_found";
	workspace_name?: string;
	role?: string;
	expires_at?: string;
};

export const usePublicInviteStatus = (
	email: string,
	hash: string,
	{ enabled = true }: { enabled?: boolean } = {},
) =>
	useQuery({
		enabled: enabled && hash.length > 0 && email.length > 0,
		queryFn: async (): Promise<PublicInviteStatus> => {
			const params = new URLSearchParams({ email, h: hash });
			const res = await fetch(
				`${API_BASE_URL}/v2/auth/invite-status?${params.toString()}`,
			);
			if (!res.ok) {
				// Failures degrade to not_found so the UI never lets the user
				// proceed into register on a probably-dead invite.
				return { status: "not_found" };
			}
			return res.json();
		},
		queryKey: ["v2", "auth", "invite-status", email, hash],
		staleTime: 60_000,
	});

export const useInviteByHash = (
	hash: string,
	{ enabled = true }: { enabled?: boolean } = {},
) =>
	useQuery({
		enabled: enabled && hash.length > 0,
		queryFn: async (): Promise<InviteByHashState> => {
			const res = await fetch(
				`${API_BASE_URL}/v2/me/invites/by-hash?h=${encodeURIComponent(hash)}`,
				{ credentials: "include" },
			);
			if (!res.ok) {
				// Failures degrade to not_found so the UI never gets stuck.
				return { status: "not_found" };
			}
			return res.json();
		},
		// State changes only via accept (which invalidates this key), so
		// long staleTime is safe and avoids refetch flicker.
		queryKey: ["v2", "me", "invites", "by-hash", hash],
		staleTime: 60_000,
	});

export const useAcceptInviteByHash = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			hash,
			claimedRole,
		}: {
			hash: string;
			claimedRole?: string | null;
		}): Promise<AcceptInviteResult> => {
			const res = await fetch(`${API_BASE_URL}/v2/me/invites/accept-by-hash`, {
				body: JSON.stringify({ claimed_role: claimedRole ?? null, hash }),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const err = new Error(data.detail || "Failed to accept invite");
				(err as Error & { status?: number }).status = res.status;
				throw err;
			}
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
		},
	});
};
