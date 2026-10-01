/**
 * Generates data-testid attribute for testing frameworks.
 *
 * Naming convention: {feature}-{component}-{element}
 * Examples:
 *   - testId("project-card-delete-button")
 *   - testId("auth-password-reset-email-input")
 */
export const testId = (id: string): { "data-testid": string } => ({
	"data-testid": id,
});
