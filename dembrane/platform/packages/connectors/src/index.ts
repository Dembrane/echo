import type { Queue } from "@dembrane/queue";
import { syncDueSources, syncSource } from "./jobs";
import type { ConnectorDeps } from "./service";
import { runSync } from "./sync";

export { connectorApiJobs, syncDueSources, syncSource } from "./jobs";
export {
  frameLink,
  httpMiro,
  type Miro,
  type MiroBoard,
  MiroError,
  type MiroFrame,
  type MiroItem,
  type MiroTokens,
  miroBoardId,
} from "./miro";
export { contentHash, htmlToText, readingOrder, type Segment, segments } from "./render";
export {
  type ConnectorRoutesDeps,
  connectorDeps,
  connectorRoutes,
  miroRedirectUri,
} from "./routes";
export { type OAuthState, readState, type Sealer, signState, tokenSealer } from "./seal";
export { type ConnectorDeps, PROVIDERS, type Provider, VOICES, type Voice } from "./service";
export { type ConnectorStorage, connectorStorage } from "./storage";
export { MIRO_SOURCE, type MiroOrigin, runSync, type SyncResult } from "./sync";

const RESYNC_AFTER_MS = 6 * 3600_000;

/** The worker's side: syncs on request, and an hourly sweep re-reads stale sources. */
export function connectorWorker(d: ConnectorDeps) {
  return {
    jobs: [syncSource, syncDueSources],
    async register(queue: Queue) {
      await queue.work(syncSource, { concurrency: 4 }, async (p) => {
        await runSync(d, p.sourceId);
      });
      await queue.work(syncDueSources, { concurrency: 1 }, async () => {
        const due = await d.store.dueSources(new Date(d.now().getTime() - RESYNC_AFTER_MS), 100);
        for (const { id } of due)
          await queue.enqueue(syncSource, { sourceId: id }, { singletonKey: id });
      });
      await queue.schedule(syncDueSources, "17 * * * *", {});
    },
  };
}
