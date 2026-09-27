import { ForbiddenError, newId, PlatformError } from "@echo/core";
import type { Logger } from "@echo/observability";
import type { ObjectStorage } from "@echo/storage";
import type { PricingInsert, PricingRow, PricingStore } from "./storage";

/**
 * The durable row behind the pricing configurator, one per attempt, keyed on the
 * browser's config_session_id and grown by every step. The reference is minted once and
 * never changes. Identity comes from the session (app) or from the booking (site).
 */
export const INTERNAL_EMAIL_DOMAIN = "@dembrane.com";
export const APP_PREFIX = "DEM-";
export const SITE_PREFIX = "WEB-";
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const REFERENCE_ATTEMPTS = 8;

export interface PricingPayload {
  config_session_id: string;
  question_set_version: string;
  config_shape_version: number | null;
  mount: "app" | "site";
  locale: string;
  wall_key: string | null;
  workspace_id: string | null;
  org_id: string | null;
  project_id: string | null;
  answers_raw: Record<string, unknown>;
  config: Record<string, unknown>;
  status: "in_progress" | "submitted";
  booking_uid: string | null;
  booking_status: string | null;
  booking_start: string | null;
}

export interface Attachment {
  readonly questionKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly durationMs: number | null;
  readonly content: Uint8Array;
}

class ServerError extends PlatformError {
  readonly status = 500;
  readonly code = "internal";
}

export function newReference(prefix: string, random: () => number = Math.random): string {
  let body = "";
  for (let i = 0; i < 4; i++) body += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return `${prefix}${body}`;
}

/** Empty strings become NULL, so unanswered and sent-as-blank read the same. */
export function clean(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v.trim() || null;
}

export function cleanEmail(v: string | null | undefined): string | null {
  const c = clean(v);
  if (c === null) return null;
  const lower = c.toLowerCase();
  return lower.includes("@") && !lower.includes(" ") ? lower : null;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** The four values a person scanning the table needs without opening the JSON. */
export function flatMirrors(config: Record<string, unknown>) {
  return {
    volume_bucket: typeof config.volume === "string" ? config.volume : null,
    concurrency_bucket: typeof config.concurrency === "string" ? config.concurrency : null,
    concurrency_exact: isInt(config.concurrency_exact) ? config.concurrency_exact : null,
    answered_count: isInt(config.answered) ? config.answered : null,
    furthest_step: isInt(config.furthest_step) ? config.furthest_step : null,
  };
}

export interface Booking {
  uid: string;
  status: string | null;
  start: string | null;
}

/** The booking this write reports; without a uid there is nothing to join on, so none. */
export function bookingFrom(p: PricingPayload): Booking | null {
  const uid = clean(p.booking_uid);
  if (!uid) return null;
  const status = clean(p.booking_status);
  return { uid, status: status ? status.toLowerCase() : null, start: clean(p.booking_start) };
}

/**
 * The client's config with the booking kept inside it (the table has no column for the
 * start time). A stored booking is carried forward because the client resends config
 * without it; the same uid merges, a new uid replaces.
 */
export function configWithBooking(
  config: Record<string, unknown>,
  existing: Pick<PricingRow, "config"> | null,
  booking: Booking | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...config };
  const stored = existing?.config;
  let carried: Record<string, unknown> | null = null;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const b = (stored as Record<string, unknown>).booking;
    if (b && typeof b === "object" && !Array.isArray(b)) carried = b as Record<string, unknown>;
  }
  if (!booking) {
    if (carried && Object.keys(carried).length) merged.booking = carried;
    return merged;
  }
  const entry: Record<string, unknown> = {};
  if (carried && carried.uid === booking.uid) Object.assign(entry, carried);
  for (const [k, v] of Object.entries(booking)) if (v !== null) entry[k] = v;
  merged.booking = entry;
  return merged;
}

/** One entry per question key, newest write wins. */
export function mergeAudio(existing: unknown, stored: Record<string, unknown>[]) {
  const byKey = new Map<string, unknown>();
  if (Array.isArray(existing))
    for (const e of existing)
      if (
        e &&
        typeof e === "object" &&
        typeof (e as { question_key?: unknown }).question_key === "string"
      )
        byKey.set((e as { question_key: string }).question_key, e);
  for (const e of stored) byKey.set(e.question_key as string, e);
  return [...byKey.values()];
}

export interface UpsertDeps {
  readonly store: PricingStore;
  readonly storage: ObjectStorage;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly random?: () => number;
}

export async function upsertConfiguration(
  d: UpsertDeps,
  payload: PricingPayload,
  attachments: readonly Attachment[],
  identity: { email: string | null; userId: string | null; isInternal: boolean; prefix: string },
): Promise<{ reference: string; warnings: string[] }> {
  const now = (d.clock ?? (() => new Date()))();
  const sessionId = payload.config_session_id.trim();
  const existing = await d.store.bySession(sessionId);
  if (existing?.user_id && existing.user_id !== identity.userId)
    throw new ForbiddenError("This configuration belongs to another user");

  const booking = bookingFrom(payload);
  // A finished configuration never falls back to in progress, and a booking only raises it.
  const status = booking || existing?.status === "submitted" ? "submitted" : payload.status;

  const row: Partial<PricingInsert> & Record<string, unknown> = {
    config_session_id: sessionId,
    status,
    email: identity.email,
    user_id: identity.userId,
    is_internal: identity.isInternal,
    locale: clean(payload.locale),
    mount: payload.mount,
    wall_key: clean(payload.wall_key),
    workspace_id: clean(payload.workspace_id),
    org_id: clean(payload.org_id),
    project_id: clean(payload.project_id),
    question_set_version: clean(payload.question_set_version),
    config_shape_version: payload.config_shape_version,
    answers_raw: payload.answers_raw,
    ...flatMirrors(payload.config),
    config: configWithBooking(payload.config, existing, booking),
  };
  if (existing && identity.email === null) {
    // A site row learns its email from the booking once; other writes must not erase it.
    delete row.email;
    delete row.is_internal;
  }
  if (booking) {
    if (existing?.booking_uid && existing.booking_uid !== booking.uid) {
      d.logger.warn(
        { sessionId, previous: existing.booking_uid, next: booking.uid },
        "pricing configuration booked twice; the newest wins",
      );
      // The new booking has not been forwarded yet: clearing the stamp lets the outbox send it.
      row.booking_notified_at = null;
    }
    row.booking_uid = booking.uid;
    if (booking.status) row.booking_status = booking.status;
  }

  let rowId: string;
  let reference: string;
  let storedAudio: unknown = existing?.voice_audio ?? null;
  if (existing) {
    rowId = existing.id;
    const updated = await d.store.update(rowId, row, now);
    reference = updated?.reference || existing.reference || "";
    if (!reference) {
      reference = newReference(identity.prefix, d.random);
      await d.store.update(rowId, { reference }, now);
    }
  } else {
    const created = await insertWithReference(d, row, identity.prefix, now);
    rowId = created.id;
    reference = created.reference ?? "";
    storedAudio = created.voice_audio;
  }

  const warnings: string[] = [];
  if (attachments.length) {
    const entries: Record<string, unknown>[] = [];
    for (const a of attachments) {
      const entry: Record<string, unknown> = {
        question_key: a.questionKey,
        duration_ms: a.durationMs,
        stored: false,
      };
      if (!a.content.byteLength) {
        entry.error = "empty or over the size cap";
        warnings.push(
          `The recording for ${a.questionKey} was empty or too large, so it was not stored.`,
        );
        entries.push(entry);
        continue;
      }
      try {
        const key = `pricing/${rowId}/${newId()}-${a.filename.replace(/[^A-Za-z0-9._-]/g, "_")}`;
        await d.storage.put(key, a.content, a.contentType);
        entry.stored = true;
        entry.storage_key = key;
      } catch (err) {
        d.logger.error({ err, question: a.questionKey }, "storing a pricing recording failed");
        entry.error = String(err instanceof Error ? err.message : err).slice(0, 300);
        warnings.push(
          `The answers were saved. The recording for ${a.questionKey} could not be stored.`,
        );
      }
      entries.push(entry);
    }
    try {
      await d.store.update(rowId, { voice_audio: mergeAudio(storedAudio, entries) }, now);
    } catch (err) {
      d.logger.error({ err }, "could not record pricing audio metadata");
      warnings.push("The recording metadata could not be written to the row.");
    }
  }
  return { reference, warnings };
}

/**
 * Creates the row with a fresh reference. A failed insert is either a concurrent write
 * of the same session (answer with that row) or a reference collision (try another).
 */
async function insertWithReference(
  d: UpsertDeps,
  row: Partial<PricingInsert>,
  prefix: string,
  now: Date,
): Promise<PricingRow> {
  for (let i = 0; i < REFERENCE_ATTEMPTS; i++) {
    try {
      return await d.store.insert({
        ...(row as PricingInsert),
        id: newId(),
        reference: newReference(prefix, d.random),
        created_at: now.toISOString(),
      });
    } catch (err) {
      const existing = await d.store.bySession(row.config_session_id as string);
      if (existing) return existing;
      d.logger.warn({ err }, "pricing configuration insert retry");
    }
  }
  throw new ServerError("Could not allocate a reference");
}
