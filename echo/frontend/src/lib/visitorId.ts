// A client-minted, device-persistent id for a portal visitor, so the host
// funnel can track someone from the moment they scan the QR — before any
// conversation exists — and recognise a re-scan from the same device instead
// of drawing a phantom new dot. It is an anonymous random UUID (no PII).

const visitorKey = (projectId: string) => `dembrane:visitor:${projectId}`;
const scanKey = (projectId: string) => `dembrane:visitor-scans:${projectId}`;

const randomId = (): string => {
	try {
		if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
			return crypto.randomUUID();
		}
	} catch {
		// fall through
	}
	return `v-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
};

// Fallback ids when localStorage is blocked, cached per project so repeated
// calls return the same id (else each call re-randomises into phantom dots).
const ephemeralIds: Record<string, string> = {};

/** Stable visitor id for this device + project, minted once and reused. */
export const getVisitorId = (projectId: string): string => {
	try {
		const existing = localStorage.getItem(visitorKey(projectId));
		if (existing) return existing;
		const fresh = randomId();
		localStorage.setItem(visitorKey(projectId), fresh);
		return fresh;
	} catch {
		if (!ephemeralIds[projectId]) ephemeralIds[projectId] = randomId();
		return ephemeralIds[projectId];
	}
};

/** Increment and return how many times this device has started a portal
 * session for the project — the "scanned twice" signal. */
export const bumpScanCount = (projectId: string): number => {
	try {
		const next = (Number(localStorage.getItem(scanKey(projectId))) || 0) + 1;
		localStorage.setItem(scanKey(projectId), String(next));
		return next;
	} catch {
		return 1;
	}
};
