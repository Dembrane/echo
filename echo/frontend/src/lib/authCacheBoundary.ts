export const AUTH_CACHE_BOUNDARY_EVENT = "dembrane.auth-cache-boundary";

export function emitAuthCacheBoundary(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new Event(AUTH_CACHE_BOUNDARY_EVENT));
}
