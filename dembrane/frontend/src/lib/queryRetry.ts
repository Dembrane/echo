import { readApiError } from "./errors/read";

// A refused request (an ended session, a missing project, no access) answers the
// same way on every retry: say so at once instead of after three backoffs.
export const queryRetry = (failures: number, error: unknown) => {
	const status = readApiError(error).status;
	if (status && status >= 400 && status < 500 && ![408, 429].includes(status))
		return false;
	return failures < 3;
};
