/**
 * A transcription profile: the whole transcription pipeline of a stack in one named, typed
 * object, so a deployment picks a pipeline by name (TRANSCRIPTION_PROFILE) and every
 * transcript says which pipeline made it. What depends on the deployment (keys, base URL,
 * Vertex project, the provider's per-minute budget) stays in the environment.
 *
 * A new pipeline is a new profile with a new name; a stored transcript keeps naming the one
 * that made it, so a profile is never changed in place once deployed.
 */
export type SpeechProvider = "whisper" | "gemini";

export interface TranscriptionProfile {
  readonly name: string;
  /** The text written while people talk, piece by piece. */
  readonly live: {
    readonly provider: SpeechProvider;
    readonly model: string;
    /** auto: Whisper hears each piece's language; project: the project's language is sent. Whisper only. */
    readonly language: "auto" | "project";
    /** A doubtful stretch of Whisper's answer is read again alone and the better reading kept. Whisper only. */
    readonly secondListen: boolean;
  };
  /**
   * After a conversation recorded in the portal ends. redo: the whole recording is heard again
   * in pieces cut at pauses, which repairs the words lost where the 30 second pieces were cut
   * and gives every sentence its time.
   */
  readonly recordings: "none" | "redo";
  /**
   * After an uploaded conversation ends. first-pass: the upload was already cut at pauses into
   * pieces short enough for sentence times, so its first reading is kept and only cleaned up;
   * redo: as a recording.
   */
  readonly uploads: "none" | "first-pass" | "redo";
  /** Who hears a recording again. */
  readonly redo: { readonly provider: SpeechProvider; readonly model: string } | null;
  /** A text model that edits inside the improved transcript's sentences (key terms, mishearings), times kept. On the OpenAI-compatible provider. */
  readonly cleanUp: { readonly model: string } | null;
  /** Longest piece a transcript with sentence times is read in: over longer pieces the models' own times drift (Whisper 2.7 s at five minutes, 0.2 s at one). */
  readonly timedPieceSeconds: number;
}

export const PROFILES = {
  // EU on Scaleway: Whisper while people talk, Whisper again over a finished recording,
  // GLM over the result. Words wrong per 100 on the public test sets: 16.0 live with the second
  // listen, 14.0 after the redo and the clean-up.
  "dembrane-26-10-whisper-eu": {
    name: "dembrane-26-10-whisper-eu",
    live: { provider: "whisper", model: "whisper-large-v3", language: "auto", secondListen: true },
    recordings: "redo",
    uploads: "first-pass",
    redo: { provider: "whisper", model: "whisper-large-v3" },
    cleanUp: { model: "glm-5.3" },
    timedPieceSeconds: 60,
  },
  // GCP on Vertex: Gemini's live text is as good as a second Gemini pass over the whole
  // recording (9.7 against 10.0 words wrong per 100), so nothing runs after the conversation.
  "dembrane-26-10-gemini": {
    name: "dembrane-26-10-gemini",
    live: {
      provider: "gemini",
      model: "gemini-3.8-flash",
      language: "project",
      secondListen: false,
    },
    recordings: "none",
    uploads: "none",
    redo: null,
    cleanUp: null,
    timedPieceSeconds: 60,
  },
} as const satisfies Record<string, TranscriptionProfile>;

export type ProfileName = keyof typeof PROFILES;
export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];

/** The profile a deployment names, or the stack's own when it names none: Gemini on Vertex, the EU profile on a compatible provider. */
export function profileOf(s: {
  readonly provider: "vertex" | "openai-compatible";
  readonly transcriptionProfile?: string | undefined;
}): TranscriptionProfile {
  const name = s.transcriptionProfile?.trim();
  if (!name)
    return s.provider === "vertex"
      ? PROFILES["dembrane-26-10-gemini"]
      : PROFILES["dembrane-26-10-whisper-eu"];
  const p = (PROFILES as Record<string, TranscriptionProfile>)[name];
  if (!p)
    throw new Error(
      `TRANSCRIPTION_PROFILE ${name} is not a profile; known: ${PROFILE_NAMES.join(", ")}`,
    );
  return p;
}

/** Whether anything runs after a conversation of this kind ends. */
export const improves = (p: TranscriptionProfile, upload: boolean) =>
  (upload ? p.uploads : p.recordings) !== "none";

/** Providers the profile calls, for the boot check. */
function needs(p: TranscriptionProfile) {
  const speech = new Set<SpeechProvider>([p.live.provider]);
  if (p.redo && (p.recordings === "redo" || p.uploads === "redo")) speech.add(p.redo.provider);
  return { compatible: speech.has("whisper") || p.cleanUp !== null, vertex: speech.has("gemini") };
}

/**
 * What the deployment lacks for the profile, as one line naming the profile, or null when it
 * has it all. Whisper and the clean-up model need the compatible provider's URL and key;
 * Gemini needs a Vertex project.
 */
export function profileGaps(
  p: TranscriptionProfile,
  s: {
    readonly baseUrl?: string | undefined;
    readonly apiKey?: string | undefined;
    readonly vertexProject?: string | undefined;
  },
): string | null {
  const n = needs(p);
  const missing = [
    ...(n.compatible && !s.baseUrl ? ["LLM_BASE_URL"] : []),
    ...(n.compatible && !s.apiKey ? ["LLM_API_KEY"] : []),
    ...(n.vertex && !s.vertexProject ? ["LLM_VERTEX_PROJECT"] : []),
  ];
  return missing.length
    ? `transcription profile ${p.name} needs ${missing.join(" and ")}, which ${missing.length > 1 ? "are" : "is"} not set`
    : null;
}

/** The compatible provider's models the profile calls, for the boot check against /v1/models. */
export function compatibleModelsOf(p: TranscriptionProfile): string[] {
  const out = new Set<string>();
  if (p.live.provider === "whisper") out.add(p.live.model);
  if (p.redo?.provider === "whisper" && (p.recordings === "redo" || p.uploads === "redo"))
    out.add(p.redo.model);
  if (p.cleanUp) out.add(p.cleanUp.model);
  return [...out];
}

/**
 * Warns when the compatible provider does not list a model the profile calls. A network
 * error says nothing: boot never waits on the provider.
 */
export async function checkProfileModels(
  p: TranscriptionProfile,
  s: { readonly baseUrl?: string | undefined; readonly apiKey?: string | undefined },
  warn: (line: string) => void,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const wanted = compatibleModelsOf(p);
  if (!wanted.length || !s.baseUrl || !s.apiKey) return;
  try {
    const res = await fetcher(`${s.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${s.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const listed = new Set((body.data ?? []).map((m) => String(m.id)));
    const absent = wanted.filter((m) => !listed.has(m));
    if (absent.length)
      warn(
        `transcription profile ${p.name}: the provider does not list ${absent.join(", ")}; those calls will fail`,
      );
  } catch {
    // Unreachable at boot is not a reason to stop; the calls themselves report.
  }
}
