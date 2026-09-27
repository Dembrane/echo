import type { Db } from "@echo/db";
import type { Mailer } from "@echo/mail";
import type { Logger } from "@echo/observability";
import type { Mollie } from "./mollie";
import { Notifier } from "./notify";
import { type BillingConfig, BillingService, type Capture, RepriceMemo } from "./service";
import { billingStorage, pgTryLock } from "./storage";
import type { BillingStore } from "./store";

export interface BillingWiring {
  readonly db: Db;
  readonly mollie: Mollie;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly billingConfig: BillingConfig;
  readonly capture?: Capture;
  readonly clock?: () => Date;
}

export interface Billing {
  readonly service: BillingService;
  readonly mollie: Mollie;
  readonly store: BillingStore;
  readonly notifier: Notifier;
}

const memos = new WeakMap<Db, RepriceMemo>();

/** Builds the billing service over Postgres; the API, the worker and the staff routes share it. */
export function createBilling(w: BillingWiring): Billing {
  const store = billingStorage(w.db);
  const notifier = new Notifier(store, w.logger);
  let memo = memos.get(w.db);
  if (!memo) {
    memo = new RepriceMemo();
    memos.set(w.db, memo);
  }
  const service = new BillingService({
    store,
    mollie: w.mollie,
    mailer: w.mailer,
    notifier,
    logger: w.logger,
    config: w.billingConfig,
    capture: w.capture ?? (async () => {}),
    repriceMemo: memo,
    tryLock: pgTryLock(w.db),
    clock: w.clock ?? (() => new Date()),
  });
  return { service, store, notifier, mollie: w.mollie };
}
