// Keep in sync with server/dembrane/password_policy.py and the
// auth_password_policy regex in directus/sync/collections/settings.json.

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

export function validatePassword(password: string): PasswordValidation {
	const rules: PasswordRules = {
		lowercase: /[a-z]/.test(password),
		minLength: password.length >= PASSWORD_MIN_LENGTH,
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
		strength = password.length >= 12 ? "strong" : "fair";
	}

	return { isValid, rules, strength };
}
