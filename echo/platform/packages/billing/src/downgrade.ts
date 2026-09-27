/**
 * What a workspace loses when its tier drops below a gate (old tier_downgrade.py).
 * "revert" clears feature state; "freeze" keeps existing use and blocks new use through
 * the tier gate. Order matches the old map so emails list effects the same way.
 */
const TIER_ORDER = ["free", "innovator", "changemaker", "guardian"];

const TIER_REQUIRED: readonly [string, string][] = [
  ["workspace:export", "innovator"],
  ["project:share", "innovator"],
  ["workspace:whitelabel", "changemaker"],
  ["workspace:api_access", "changemaker"],
  ["workspace:webhooks", "changemaker"],
  ["workspace:set_private", "innovator"],
  ["project:set_private", "innovator"],
];

const EFFECT: Readonly<Record<string, "revert" | "freeze">> = {
  "workspace:whitelabel": "revert",
  "workspace:api_access": "freeze",
  "workspace:webhooks": "freeze",
  "workspace:export": "freeze",
  "project:share": "freeze",
  "workspace:set_private": "freeze",
  "project:set_private": "freeze",
};

const HUMAN: Readonly<Record<string, string>> = {
  "workspace:whitelabel": "Remove your custom logo (revert to dembrane logo)",
  "workspace:api_access": "Freeze API access (existing tokens keep working; no new tokens)",
  "workspace:webhooks": "Freeze webhooks (existing webhooks keep firing; no new configs)",
  "workspace:export": "Freeze data export (existing files stay; new exports blocked)",
  "project:share": "Freeze private project sharing (existing shares stay; no new shares)",
  "workspace:set_private": "Freeze ability to make new private workspaces",
  "project:set_private": "Freeze ability to make new private projects",
};

export interface DowngradeEffect {
  readonly policy: string;
  readonly effect: "revert" | "freeze";
  readonly human: string;
}

/** Unknown tiers never meet a gate, as in the old meets_tier. */
export function meetsTier(current: string, minimum: string): boolean {
  const a = TIER_ORDER.indexOf(current);
  const b = TIER_ORDER.indexOf(minimum);
  return a >= 0 && b >= 0 && a >= b;
}

export function previewDowngrade(fromTier: string, toTier: string): DowngradeEffect[] {
  if (meetsTier(toTier, fromTier)) return [];
  return TIER_REQUIRED.filter(([, req]) => meetsTier(fromTier, req) && !meetsTier(toTier, req)).map(
    ([policy]) => ({
      policy,
      effect: EFFECT[policy] ?? "freeze",
      human: HUMAN[policy] ?? policy,
    }),
  );
}
