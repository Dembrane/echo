// Read state is decided here, not by a Directus `_none` filter: multi-condition
// `_none` matches nothing, and permission-based scoping breaks for admins.

export function notExpiredFilter(now: string = new Date().toISOString()) {
	return {
		_or: [
			{ expires_at: { _gte: now } },
			{ expires_at: { _null: true } },
		] as const,
	};
}

export interface ActivityReadState {
	read?: boolean | null;
}

/** Any read row wins: unmarking leaves `read: false`, which is not read. */
export function isReadByMe(activity: ActivityReadState[] | null | undefined) {
	return (activity ?? []).some((row) => row.read === true);
}

export function isUnreadByMe(activity: ActivityReadState[] | null | undefined) {
	return !isReadByMe(activity);
}
