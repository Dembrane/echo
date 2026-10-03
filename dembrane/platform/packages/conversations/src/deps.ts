import type { Access } from "@dembrane/access";
import type { Media } from "@dembrane/audio";
import type { Db } from "@dembrane/db";
import type { Models } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type { EnqueueOptions, JobDefinition, Payload } from "@dembrane/queue";
import type { RateLimiter } from "@dembrane/ratelimit";
import type { Hub } from "@dembrane/realtime";
import type { ObjectStorage } from "@dembrane/storage";
import type { Transcriber } from "@dembrane/transcription";
import type { AudioUrls } from "./audio-urls";
import type { ParticipantTokens } from "./participant-token";

/** Producer side of the queue: the API enqueues jobs and starts workflows, the worker runs them. */
export interface JobSink {
  enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts?: EnqueueOptions,
  ): Promise<string | null>;
}

export interface ConversationSettings {
  /** Portal calls must carry the participant token (Q7); off during the transition. */
  readonly participantTokenRequired: boolean;
  /** ENABLE_MONITOR: pings are stored and monitor streams are fed. */
  readonly monitorEnabled: boolean;
  /** ENABLE_WEBHOOKS: conversation events enqueue deliveries. */
  readonly webhooksEnabled: boolean;
  readonly dashboardUrl: string;
}

/** Everything the conversation routes need; built once by the API, faked in tests. */
export interface ConversationsDeps {
  readonly db: Db;
  readonly access: Access;
  /** The audio bucket (participant chunks, merged audio). */
  readonly audio: ObjectStorage;
  readonly audioUrls: AudioUrls;
  readonly jobs: JobSink;
  readonly models: Models;
  /** ffmpeg work (merge on read, duration probes); the media service in the cloud. */
  readonly media: Media;
  readonly transcriber: Transcriber;
  /** Live events; null where no LISTEN connection runs (tests). */
  readonly hub: Hub | null;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly tokens: ParticipantTokens;
  readonly settings: ConversationSettings;
  readonly now: () => Date;
}
