// Free is exactly "free"; every other tier, null or missing is unlimited.
export function isFreeTier(tier: string | null | undefined): boolean {
  return tier === "free";
}
