import { BadRequestError } from "@dembrane/core";
import type { ProjectsStorage } from "./storage";

/**
 * The legal basis cascade: project override, then workspace, then the legacy owner's
 * setting, then client-managed. Basis and privacy link always come from one level.
 */
export const LEGAL_BASIS_VALUES = ["client-managed", "consent", "dembrane-events"] as const;

interface Level {
  legal_basis?: string | null;
  privacy_policy_url?: string | null;
}

export function effectiveLegalBasis(levels: {
  project?: Level | null;
  workspace?: Level | null;
  owner?: Level | null;
}) {
  const order: [Level | null | undefined, string][] = [
    [levels.project, "project"],
    [levels.workspace, "workspace"],
    [levels.owner, "legacy_user"],
  ];
  for (const [lvl, source] of order)
    if (lvl?.legal_basis)
      return {
        legal_basis: lvl.legal_basis,
        privacy_policy_url: lvl.privacy_policy_url ?? null,
        source,
      };
  return { legal_basis: "client-managed", privacy_policy_url: null, source: "default" };
}

/** The `_legal` block of the project detail: effective, what it would be without the override, and the organiser. */
export async function legalBlock(
  store: ProjectsStorage,
  project: Level & { workspace_id: string | null; directus_user_id: string | null },
) {
  const rows = await store.legalCascade(project.workspace_id, project.directus_user_id);
  const ws = rows.workspace;
  let organiser: string | null = null;
  if (ws?.data_owner_org_name) organiser = ws.data_owner_org_name;
  else if (ws && isExternalClient(ws)) organiser = null;
  else organiser = rows.org?.name ?? null;
  return {
    effective: effectiveLegalBasis({ project, workspace: ws, owner: rows.owner }),
    inherited: effectiveLegalBasis({ workspace: ws, owner: rows.owner }),
    organiser_name: organiser,
  };
}

/**
 * Validates a legal edit against the merged state of one level. Null when the request
 * carries no legal field, so stale rows never block other edits.
 */
export function legalWrite(input: {
  fieldsSet: ReadonlySet<string>;
  legalBasis: string | null;
  privacyPolicyUrl: string | null;
  storedLegalBasis: string | null;
  storedPrivacyPolicyUrl: string | null;
}) {
  const basisSent = input.fieldsSet.has("legal_basis");
  const urlSent = input.fieldsSet.has("privacy_policy_url");
  if (!basisSent && !urlSent) return null;
  if (
    basisSent &&
    input.legalBasis !== null &&
    !(LEGAL_BASIS_VALUES as readonly string[]).includes(input.legalBasis)
  )
    throw new BadRequestError("Invalid legal basis");
  const basis = basisSent ? input.legalBasis : input.storedLegalBasis;
  let url = urlSent ? input.privacyPolicyUrl : input.storedPrivacyPolicyUrl;
  if (basis === "consent") {
    if (!url?.trim())
      throw new BadRequestError("A privacy policy link is required for consent-based processing");
    url = url.trim();
    if (url.length > 255)
      throw new BadRequestError("Privacy policy URL must be 255 characters or fewer");
    if (!/^https?:\/\//i.test(url))
      throw new BadRequestError("Privacy policy URL must start with http:// or https://");
  } else url = null;
  return {
    payload: { legal_basis: basis, privacy_policy_url: url },
    requiresDembraneEmail:
      basis === "dembrane-events" && input.storedLegalBasis !== "dembrane-events",
  };
}

/** A workspace run for an external client (a partner's customer) rather than internal use. */
export function isExternalClient(ws: {
  usage_context?: unknown;
  data_owner_email?: unknown;
  billed_to_team_id?: unknown;
  org_id?: unknown;
}): boolean {
  const uc = String(ws.usage_context ?? "")
    .trim()
    .toLowerCase();
  if (uc) return uc === "external";
  if (String(ws.data_owner_email ?? "").trim()) return true;
  return Boolean(ws.billed_to_team_id) && ws.billed_to_team_id !== ws.org_id;
}
