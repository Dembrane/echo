// Read state is decided here from the caller's own read marks, which the API returns
// as `activity`; expiry is filtered by the API.

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
