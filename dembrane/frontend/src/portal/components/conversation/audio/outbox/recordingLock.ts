/** Held by a tab for as long as it records into a slice group. */
export const recordingLockName = (groupId: string) => `recording:${groupId}`;

/**
 * Holds a slice group's recording lock until `release()`, so no drainer, in
 * this tab or another, seals the group as a dead recording's. `held` resolves
 * once the lock is granted, or at once in a browser without Web Locks, where
 * drainers recover no groups at all.
 */
export const holdRecordingLock = (groupId: string) => {
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const held = new Promise<void>((resolve) => {
		if (!navigator.locks?.request) return resolve();
		navigator.locks
			.request(recordingLockName(groupId), () => {
				resolve();
				return released;
			})
			.catch(() => resolve());
	});
	return { held, release };
};
