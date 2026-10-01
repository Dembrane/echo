/**
 * Training is its own product, separate from billing tiers. A user is trained while
 * they hold a training_license with status active and an expiry in the future; that
 * row is the one-year high-risk verification record.
 */
export const LICENSE_DURATION_DAYS = 365;
/** Inside this window before expiry a licence reads as expiring soon. */
export const EXPIRING_SOON_DAYS = 30;

export interface TrainingProduct {
  readonly type: string;
  readonly name: string;
  readonly price_eur: number;
  readonly included_participants: number;
  readonly extra_price_eur: number | null;
  readonly level: string;
  readonly format: string;
  readonly grants_license: boolean;
  readonly coming_soon: boolean;
}

/** The catalog as sold on dembrane.com. Flex is self-paced and not requestable yet. */
export const CATALOG: readonly TrainingProduct[] = [
  {
    type: "online",
    name: "Online",
    price_eur: 675,
    included_participants: 5,
    extra_price_eur: 60,
    level: "Foundational, 2h",
    format: "Remote",
    grants_license: true,
    coming_soon: false,
  },
  {
    type: "in_person",
    name: "In person",
    price_eur: 2500,
    included_participants: 10,
    extra_price_eur: 195,
    level: "Advanced, 4h",
    format: "On-site",
    grants_license: true,
    coming_soon: false,
  },
  {
    type: "flex",
    name: "Flex",
    price_eur: 50,
    included_participants: 1,
    extra_price_eur: null,
    level: "Self-paced",
    format: "Course",
    grants_license: true,
    coming_soon: true,
  },
];

export function getProduct(type: string): TrainingProduct | null {
  return CATALOG.find((p) => p.type === type) ?? null;
}

export function isRequestable(type: string): boolean {
  const p = getProduct(type);
  return p !== null && !p.coming_soon;
}

/** A licence always expires exactly LICENSE_DURATION_DAYS after completion. */
export function computeExpiresAt(completedAt: Date): Date {
  return new Date(completedAt.getTime() + LICENSE_DURATION_DAYS * 86_400_000);
}

/**
 * Python datetime.fromisoformat for the inputs staff send: a date or a date-time,
 * with or without an offset or Z. A value without an offset is UTC, as the old
 * service assumed. Null when unreadable.
 */
export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (!m) {
    // Postgres prints "+00" offsets; accept those for stored values.
    const pg = /^(.*[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})$/.exec(value.trim());
    if (!pg) return null;
    const d = new Date(`${(pg[1] as string).replace(" ", "T")}${pg[2]}:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, h = "00", mi = "00", s = "00", frac = "", tz] = m;
  const ms = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  let offset = "Z";
  if (tz && tz !== "Z") offset = tz.includes(":") ? tz : `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${String(ms).padStart(3, "0")}${offset}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Python isoformat() of an aware UTC datetime: seconds, microseconds only when non-zero. */
export function pyIsoformat(d: Date): string {
  const base = d.toISOString().slice(0, 19);
  const ms = d.getUTCMilliseconds();
  return `${base}${ms ? `.${String(ms).padStart(3, "0")}000` : ""}+00:00`;
}

export interface LicenseLike {
  readonly status: string | null;
  readonly expires_at: string | null;
}

export interface TrainingStatus {
  trained: boolean;
  trained_until: string | null;
  expiring_soon: boolean;
}

/** Trained means status active (null counts as active) and an expiry still ahead. */
export function licenseIsActive(row: LicenseLike, now: Date): boolean {
  if ((row.status || "active") !== "active") return false;
  const exp = parseIso(row.expires_at);
  return exp !== null && exp > now;
}

export function statusFromLicense(row: LicenseLike | null, now: Date): TrainingStatus {
  if (!row) return { trained: false, trained_until: null, expiring_soon: false };
  const exp = parseIso(row.expires_at);
  const trained = licenseIsActive(row, now);
  return {
    trained,
    trained_until: trained ? row.expires_at : null,
    expiring_soon:
      trained && exp !== null && exp.getTime() <= now.getTime() + EXPIRING_SOON_DAYS * 86_400_000,
  };
}

/**
 * The roster map: per user the furthest-out licence, preferring an active one. `rows`
 * must be sorted by expiry descending, as the query returns them.
 */
export function rosterTrainingMap(
  userIds: readonly string[],
  rows: readonly (LicenseLike & { app_user_id: string | null })[],
  now: Date,
): Map<string, TrainingStatus> {
  const best = new Map<string, LicenseLike>();
  const wanted = new Set(userIds);
  for (const r of rows) {
    const uid = r.app_user_id;
    if (!uid || !wanted.has(uid)) continue;
    const cur = best.get(uid);
    if (!cur) best.set(uid, r);
    else if (!licenseIsActive(cur, now) && licenseIsActive(r, now)) best.set(uid, r);
  }
  return new Map(userIds.map((u) => [u, statusFromLicense(best.get(u) ?? null, now)]));
}
