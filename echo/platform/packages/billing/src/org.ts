import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { BillingStore } from "./store";
import { isUuid } from "./uuid";

const { workspace, billing_account } = schema;

/**
 * The org billing page: the pooled account and its tier (what a new internal workspace
 * inherits, which gates non-open visibility at creation), plus the workspaces that bill
 * on their own account and are managed from that workspace instead.
 */
export async function orgBillingSnapshot(db: Db, store: BillingStore, orgId: string) {
  if (!isUuid(orgId)) return { account_id: null, tier: "free", separate_workspaces: [] };
  const accountId = await store.orgAccountId(orgId);
  let tier = "free";
  if (accountId) tier = (await store.account(accountId))?.tier || "free";
  const rows = await db
    .select({
      id: workspace.id,
      name: workspace.name,
      accountId: billing_account.id,
      accountOrgId: billing_account.org_id,
      tier: billing_account.tier,
      status: billing_account.status,
    })
    .from(workspace)
    .leftJoin(billing_account, eq(billing_account.id, workspace.billing_account_id))
    .where(and(eq(workspace.org_id, orgId), isNull(workspace.deleted_at)))
    .orderBy(asc(workspace.id));
  const separate = rows
    .filter((w) => w.accountId && !w.accountOrgId)
    .map((w) => ({
      workspace_id: w.id,
      name: w.name || "",
      account_id: w.accountId,
      tier: w.tier || "free",
      status: w.status || "free",
    }));
  return { account_id: accountId, tier, separate_workspaces: separate };
}
