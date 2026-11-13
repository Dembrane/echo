// Keep in sync with platform/packages/account/src/password.ts (passwordProblems), which
// the API applies to a new password.

export const PASSWORD_MIN_LENGTH = 8;

export interface PasswordRules {
	lowercase: boolean;
	uppercase: boolean;
	number: boolean;
	symbol: boolean;
	minLength: boolean;
}

export type PasswordStrength = "weak" | "fair" | "strong";

export interface PasswordValidation {
	rules: PasswordRules;
	isValid: boolean;
	strength: PasswordStrength;
}

/**
 * Characters as the server counts them: Unicode code points, so an emoji is one character
 * here as it is there, not the two UTF-16 units `string.length` gives.
 */
export function passwordLength(password: string): number {
	return [...password].length;
}

export function validatePassword(password: string): PasswordValidation {
	const length = passwordLength(password);
	const rules: PasswordRules = {
		lowercase: /[a-z]/.test(password),
		minLength: length >= PASSWORD_MIN_LENGTH,
		number: /[0-9]/.test(password),
		symbol: /[^A-Za-z0-9]/.test(password),
		uppercase: /[A-Z]/.test(password),
	};

	const isValid = Object.values(rules).every(Boolean);
	const satisfied = Object.values(rules).filter(Boolean).length;

	let strength: PasswordStrength;
	if (!isValid) {
		strength = satisfied <= 2 ? "weak" : "fair";
	} else {
		strength = length >= 12 ? "strong" : "fair";
	}

	return { isValid, rules, strength };
}
