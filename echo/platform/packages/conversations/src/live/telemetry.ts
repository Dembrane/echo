import { p } from "@echo/legacy-shape";

/**
 * The ping bodies and their sanitising (participant.py _build_ping_telemetry and
 * _build_visitor_telemetry). Both endpoints are public, so every field is optional and
 * clamped to a small, bounded value before it is stored.
 */

const { model, nested, optional, nullable, str, int, bool, float, list } = p;

export const VALID_PARTICIPANT_STATES = new Set([
  "initiated",
  "waiting",
  "recording",
  "paused",
  "verifying",
  "refining",
  "finishing",
  "finished",
  "text",
  "backgrounded",
  "left",
]);
export const VALID_VISITOR_STAGES = new Set(["scanned", "terms", "profile"]);

const networkModel = model({
  online: optional(nullable(bool()), null),
  effective_type: optional(nullable(str()), null),
  downlink: optional(nullable(float()), null),
  rtt: optional(nullable(int()), null),
});
const batteryModel = model({
  level: optional(nullable(float()), null),
  charging: optional(nullable(bool()), null),
});

export const conversationPingModel = model({
  project_id: optional(nullable(str()), null),
  state: optional(nullable(str()), null),
  mode: optional(nullable(str()), null),
  screen: optional(nullable(str()), null),
  visitor_id: optional(nullable(str()), null),
  audio_level: optional(nullable(float()), null),
  recorded_seconds: optional(nullable(float()), null),
  segment_seconds: optional(nullable(float()), null),
  client_ts: optional(nullable(int()), null),
  network: optional(nullable(nested(networkModel)), null),
  battery: optional(nullable(nested(batteryModel)), null),
});

export const visitorPingModel = model({
  stage: optional(nullable(str()), null),
  name: optional(nullable(str()), null),
  tags: optional(nullable(list(str())), null),
  tags_preselected: optional(nullable(bool()), null),
  scan_count: optional(nullable(int()), null),
  device: optional(nullable(str()), null),
  network: optional(nullable(nested(networkModel)), null),
  battery: optional(nullable(nested(batteryModel)), null),
});

export type ConversationPing = p.Infer<(typeof conversationPingModel)["shape"]>;
export type VisitorPing = p.Infer<(typeof visitorPingModel)["shape"]>;
type Network = p.Infer<(typeof networkModel)["shape"]>;
type Battery = p.Infer<(typeof batteryModel)["shape"]>;

/** Python's str.strip()[:n], counting code points. */
export function clip(s: string, n: number): string {
  return [...s.trim()].slice(0, n).join("");
}

/** Python's round(x, n): half to even on the exact binary value. */
export function pyRound(x: number, n: number): number {
  const digits = x.toFixed(Math.min(100, n + 30));
  const [whole, frac = ""] = digits.split(".");
  const keep = frac.slice(0, n);
  const rest = frac.slice(n);
  let v = Number(`${whole}.${keep || "0"}`);
  const step = 10 ** -n;
  const sign = x < 0 ? -1 : 1;
  if (/^50*$/.test(rest)) {
    const last = Number(keep.at(-1) ?? whole?.at(-1) ?? "0");
    if (last % 2 === 1) v += sign * step;
  } else if (rest[0] && Number(rest[0]) >= 5) v += sign * step;
  return Number(v.toFixed(n));
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v);

/** model_dump(exclude_none=True), in field order. */
function dropNone<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}

function network(n: Network | null): Record<string, unknown> | null {
  if (!n) return null;
  const out = dropNone(n);
  if (typeof out.effective_type === "string")
    out.effective_type = [...out.effective_type].slice(0, 12).join("");
  return Object.keys(out).length ? out : null;
}

function battery(b: Battery | null): Record<string, unknown> | null {
  if (!b) return null;
  const out = dropNone(b);
  return Object.keys(out).length ? out : null;
}

export function pingTelemetry(body: ConversationPing | null): Record<string, unknown> {
  if (!body) return {};
  const t: Record<string, unknown> = {};
  if (body.state && VALID_PARTICIPANT_STATES.has(body.state)) t.state = body.state;
  if (body.mode === "voice" || body.mode === "text") t.mode = body.mode;
  if (body.screen) t.screen = clip(body.screen, 40);
  if (body.visitor_id) t.visitor_id = clip(body.visitor_id, 64);
  if (body.audio_level !== null && finite(body.audio_level))
    t.audio_level = pyRound(Math.max(0, Math.min(1, body.audio_level)), 2);
  if (Number.isInteger(body.client_ts) && (body.client_ts as number) > 0)
    t.client_ts = body.client_ts;
  for (const f of ["recorded_seconds", "segment_seconds"] as const) {
    const v = body[f];
    if (finite(v) && v >= 0) t[f] = pyRound(v, 1);
  }
  const net = network(body.network);
  if (net) t.network = net;
  const bat = battery(body.battery);
  if (bat) t.battery = bat;
  return t;
}

export function visitorTelemetry(body: VisitorPing | null): Record<string, unknown> {
  if (!body) return {};
  const t: Record<string, unknown> = {};
  if (body.stage && VALID_VISITOR_STAGES.has(body.stage)) t.stage = body.stage;
  if (body.name) t.name = clip(body.name, 120);
  if (Array.isArray(body.tags) && body.tags.length)
    t.tags = body.tags
      .slice(0, 20)
      .filter((x) => x.trim())
      .map((x) => clip(x, 80));
  if (body.tags_preselected !== null) t.tags_preselected = Boolean(body.tags_preselected);
  if (Number.isInteger(body.scan_count))
    t.scan_count = Math.max(1, Math.min(body.scan_count as number, 999));
  if (body.device) t.device = clip(body.device, 60);
  const net = network(body.network);
  if (net) t.network = net;
  const bat = battery(body.battery);
  if (bat) t.battery = bat;
  return t;
}
