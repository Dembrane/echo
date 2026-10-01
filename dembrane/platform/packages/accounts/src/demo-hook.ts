import type { Json, ProspectHook } from "@dembrane/popcorn";
import { demoIdentity } from "@dembrane/popcorn";
import { ProspectBlock } from "./contract";
import type { AccountsDeps } from "./deps";
import { emit } from "./events";
import { createAccount } from "./prospect";
import { parse } from "./validate";

/**
 * The `prospect` block of POST /api/v2/admin/popcorn/demos. Every demo for a prospect
 * names the person it is for; they become the organisation's admin and sign in with a
 * code. Without a needs form reference the organisation's id comes from the demo's slug,
 * so seeding the same demo again finds it.
 */

export function demoProspectHook(d: AccountsDeps): ProspectHook {
  return async (who, block, opts) => {
    const p = parse(ProspectBlock, block);
    if (opts.dryRun)
      return {
        continueUrl: null,
        result: {
          dry_run: true,
          organisation_name: p.organisation_name,
          contact_email: p.contact_email,
        },
      };
    const account = await createAccount(d, who, {
      organisation_name: p.organisation_name,
      contact_email: p.contact_email,
      contact_name: p.contact_name ?? null,
      pricing_configuration_reference: p.pricing_configuration_reference ?? null,
      stage: "prospect",
      language: p.language,
      ...(!p.pricing_configuration_reference &&
        opts.slug && { org_id: demoIdentity(opts.slug, "prospect-org") }),
    });
    return {
      continueUrl: account.continue_url,
      result: { ...account } as unknown as Json,
      afterSeed: async (seeded) => {
        await d.db.transaction(async (tx) => {
          await emit(d, tx, {
            orgId: account.org_id,
            actor: { kind: "staff", userId: who.directusUserId },
            type: "demo.seeded",
            detail: { slug: opts.slug, links: seeded },
          });
        });
      },
    };
  };
}
