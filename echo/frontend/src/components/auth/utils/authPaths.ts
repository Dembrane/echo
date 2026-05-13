// Matches unauthenticated routes (locale-prefix tolerant) so they're never used as ?next=.
const AUTH_PATH_RE =
	/^\/(?:[a-z]{2}-[A-Z]{2}\/)?(?:login|register|verify-email|request-password-reset|password-reset|check-your-email)(?:$|\/|\?)/;

export const isAuthPath = (pathname: string): boolean =>
	AUTH_PATH_RE.test(pathname);
