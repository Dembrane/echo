/** The password policy the frontend and Directus also enforce: one message per unmet rule. */
export function passwordProblems(p: string): string[] {
  const out: string[] = [];
  if ([...p].length < 8) out.push("Password must be at least 8 characters");
  if (!/[a-z]/.test(p)) out.push("Password must contain a lowercase letter");
  if (!/[A-Z]/.test(p)) out.push("Password must contain an uppercase letter");
  if (!/[0-9]/.test(p)) out.push("Password must contain a number");
  if (!/[^A-Za-z0-9]/.test(p)) out.push("Password must contain a symbol");
  return out;
}
