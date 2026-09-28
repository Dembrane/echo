import type { Db } from "@dembrane/db";
import { type Completer, type Embedder, vertexName } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import { defineJob, type EnqueueOptions, type JobDefinition, type Payload } from "@dembrane/queue";
import { publish } from "@dembrane/realtime";
import { z } from "zod";
import type { Json } from "./contracts";
import { clientOf } from "./db";
import { type ExecutorDeps, liveChannel } from "./executor";
import { mapViewHook } from "./mapview";
import type { OutboxDeps } from "./outbox";
import {
  defaultProducerServices,
  POPCORN_SOURCES_KEY,
  PRODUCERS_KEY,
  sessionSources,
} from "./recipes";
import type { SnapshotHook } from "./snapshots";
import { AnalysisStore } from "./store";

/**
 * The analysis runtime as both processes build it: the API requests runs and writes
 * authored revisions, the worker executes runs and dispatches outbox events. Both enqueue
 * through the same job definitions, so a run requested by the API lands on the worker's
 * DBOS queue and a publication commits together with its dispatch.
 */

/** One recipe run: claim, execute, publish or settle (see jobs.ts). */
export const analysisRun = defineJob("analysis.run", z.object({ runId: z.string() }), {
  retryLimit: 0,
  // The whole workflow, deferrals included; each execute step has its own 60-minute limit.
  expireInSeconds: 3 * 60 * 60,
});

/** One committed publication event, dispatched to its consumers. */
export const analysisOutbox = defineJob("analysis.outbox", z.object({ eventId: z.string() }), {
  retryLimit: 0,
  expireInSeconds: 10 * 60,
});

/** Jobs the API enqueues, so its queue client knows them before the first send. */
export const analysisJobs: readonly JobDefinition[] = [analysisRun, analysisOutbox];

/** What the runtime needs from the queue; the real Queue satisfies it and tests pass a recorder. */
export interface JobSink {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: EnqueueOptions,
  ): Promise<string | null>;
}

export const mapChannel = (projectId: string) => `map:project:${projectId}`;

export interface RuntimeConfig {
  /** EMBEDDING_MODEL (a Vertex model name such as text-embedding-004). */
  readonly embeddingModel: string;
  readonly embeddingLocation: string;
}

export interface RuntimeDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly completer: Completer;
  readonly embedder: Embedder;
  readonly jobs: JobSink;
  readonly config: RuntimeConfig;
  /** View hooks other namespaces register (a popcorn bundle following its producers). */
  readonly snapshotHooks?: readonly SnapshotHook[];
}

export interface AnalysisRuntime {
  readonly store: AnalysisStore;
  readonly executor: ExecutorDeps;
  readonly outbox: OutboxDeps;
  readonly publishMap: (projectId: string, event: Json) => Promise<void>;
}

export function analysisRuntime(d: RuntimeDeps): AnalysisRuntime {
  const sql = clientOf(d.db);
  const store = new AnalysisStore(sql);
  // Every transaction that appends an outbox event enqueues its dispatch with the same
  // commit, so "published, never dispatched" cannot happen.
  store.afterPublication = async (tx, eventId) => {
    await d.jobs.enqueue(analysisOutbox, { eventId }, { tx });
  };
  const publishMap = async (projectId: string, event: Json) => {
    if (projectId) await publish(sql, mapChannel(projectId), event, d.logger);
  };
  const executor: ExecutorDeps = {
    store,
    publishEvent: async (projectId, event) => {
      if (projectId) await publish(sql, liveChannel(projectId), event, d.logger);
    },
    // A second request for a run already queued or running returns that workflow.
    dispatchRun: (runId) => d.jobs.enqueue(analysisRun, { runId }, { singletonKey: runId }),
    services: {
      [PRODUCERS_KEY]: defaultProducerServices({
        store,
        completer: d.completer,
        embedder: d.embedder,
        // The identity strings the Python settings carried, so pinned inputs and stored
        // vectors keep matching across the cutover.
        embeddingModel: vertexName(d.config.embeddingModel),
        embeddingBaseUrl: `https://${d.config.embeddingLocation}-aiplatform.googleapis.com`,
      }),
      // A popcorn run requested outside a tick reads its session from the popcorn report.
      [POPCORN_SOURCES_KEY]: sessionSources(store),
    },
    logger: d.logger,
  };
  return {
    store,
    executor,
    outbox: { executor, snapshotHooks: [mapViewHook(publishMap), ...(d.snapshotHooks ?? [])] },
    publishMap,
  };
}
