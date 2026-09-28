import { expect, test } from "bun:test";
import { buildFunnel, buildMonitorPayload, monitorStatus } from "../src/live/monitor";
import { parseSeen, pyIsoformat } from "../src/live/presence";
import { clip, pingTelemetry, pyRound, visitorTelemetry } from "../src/live/telemetry";

test("isoformat drops zero microseconds like Python", () => {
  expect(pyIsoformat(new Date("2026-09-27T10:00:00.000Z"))).toBe("2026-09-27T10:00:00+00:00");
  expect(pyIsoformat(new Date("2026-09-27T10:00:00.120Z"))).toBe(
    "2026-09-27T10:00:00.120000+00:00",
  );
  expect(parseSeen("2026-09-27T10:00:00.120000+00:00")?.toISOString()).toBe(
    "2026-09-27T10:00:00.120Z",
  );
  expect(parseSeen("2026-09-27T10:00:00")?.toISOString()).toBe("2026-09-27T10:00:00.000Z");
  expect(parseSeen("nope")).toBeNull();
});

test("round is half to even on the binary value, as Python rounds", () => {
  expect(pyRound(0.125, 2)).toBe(0.12);
  expect(pyRound(0.375, 2)).toBe(0.38);
  expect(pyRound(12.345, 1)).toBe(12.3);
  expect(pyRound(2.675, 2)).toBe(2.67);
  expect(pyRound(1, 1)).toBe(1);
});

test("ping telemetry is clamped and bounded", () => {
  const t = pingTelemetry({
    project_id: "p",
    state: "dancing",
    mode: "video",
    screen: `  ${"s".repeat(50)}  `,
    visitor_id: "v",
    audio_level: 1.7,
    recorded_seconds: -1,
    segment_seconds: 4.44,
    client_ts: 0,
    network: { online: null, effective_type: "slow-2g-and-more", downlink: null, rtt: null },
    battery: { level: null, charging: null },
  });
  expect(t).toEqual({
    screen: "s".repeat(40),
    visitor_id: "v",
    audio_level: 1,
    segment_seconds: 4.4,
    network: { effective_type: "slow-2g-and-" },
  });
  expect(pingTelemetry(null)).toEqual({});
});

test("visitor telemetry keeps twenty tags and clamps the scan count", () => {
  const t = visitorTelemetry({
    stage: "profile",
    name: " Ada ",
    tags: [" a ", "", ...Array.from({ length: 30 }, (_, i) => `t${i}`)],
    tags_preselected: false,
    scan_count: 0,
    device: null,
    network: null,
    battery: null,
  });
  expect(t.stage).toBe("profile");
  expect(t.name).toBe("Ada");
  expect((t.tags as string[]).length).toBe(19);
  expect(t.tags_preselected).toBe(false);
  expect(t.scan_count).toBe(1);
  expect(clip("  héllo  ", 3)).toBe("hél");
});

test("monitor status folds contact and audio into state and health", () => {
  const base = { pingFresh: true, contactFresh: true, audioFresh: false, chunkCount: 2 };
  expect(monitorStatus({ ...base, isFinished: true, reportedState: "recording" })).toEqual([
    "finished",
    "finished",
  ]);
  expect(monitorStatus({ ...base, isFinished: false, reportedState: "recording" })).toEqual([
    "recording",
    "stalled",
  ]);
  expect(
    monitorStatus({ ...base, isFinished: false, reportedState: "recording", segmentSeconds: 10 }),
  ).toEqual(["recording", "receiving"]);
  expect(
    monitorStatus({ ...base, contactFresh: false, isFinished: false, reportedState: "recording" }),
  ).toEqual(["offline", "offline"]);
  expect(
    monitorStatus({ ...base, contactFresh: false, isFinished: false, reportedState: "paused" }),
  ).toEqual(["left", "left"]);
  expect(
    monitorStatus({
      ...base,
      contactFresh: false,
      chunkCount: 0,
      isFinished: false,
      reportedState: null,
    }),
  ).toEqual(["initiated", "waiting"]);
});

test("the monitor payload puts live conversations first and withholds locked transcripts", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const at = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  const row = (
    conversation_id: string,
    secondsAgo: number,
    extra: Record<string, unknown> = {},
  ) => ({
    conversation_id,
    participant_name: ` ${conversation_id} `,
    is_finished: false,
    created_at: at(600),
    duration: null,
    is_over_cap: false,
    timestamp: at(secondsAgo),
    error: null,
    transcript: "hello there",
    detected_language: "en",
    desired_language: null,
    ...extra,
  });
  const payload = buildMonitorPayload({
    recentChunks: [
      row("a", 10, { is_over_cap: true, is_finished: true }),
      row("b", 300, { error: " boom " }),
    ],
    chunkCounts: new Map([
      ["a", 2],
      ["b", 3],
    ]),
    transcribedCounts: new Map([["b", 1]]),
    now,
    liveWindowSeconds: 45,
    telemetry: new Map([
      ["b", { seen: new Date(now.getTime() - 2000), state: "recording", audio_level: 0.3 }],
    ]),
    extraConversations: [
      {
        id: "c",
        participant_name: null,
        is_finished: false,
        created_at: null,
        duration: null,
        is_over_cap: false,
      },
    ],
    tier: "free",
  });
  expect(payload.conversations.map((c) => c.id)).toEqual(["b", "a", "c"]);
  const [b, a, c] = payload.conversations as Record<string, unknown>[];
  expect(b?.is_live).toBe(true);
  expect(b?.recording_health).toBe("stalled");
  expect(b?.error_message).toBe("boom");
  expect(b?.transcription_status).toBe("failing");
  expect(a?.locked).toBe(true);
  expect(a?.latest_transcript).toBeNull();
  expect(c?.state).toBe("initiated");
  expect(payload.summary).toMatchObject({
    live: 1,
    finished: 1,
    with_errors: 1,
    total: 3,
    pending_transcription: 4,
  });
});

test("the funnel drops graduated visitors and maps retired stages", () => {
  const seen = new Date("2026-09-27T12:00:00Z");
  const f = buildFunnel(
    new Map([
      ["v1", { seen, stage: "mic_ok" }],
      ["v2", { seen, stage: "weird" }],
      ["v3", { seen, stage: "profile" }],
    ]),
    new Set(["v3"]),
  );
  expect(f.summary as Record<string, number>).toEqual({
    scanned: 1,
    terms: 1,
    profile: 0,
    total: 2,
  });
});
