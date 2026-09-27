const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const VOLATILE_KEY =
  /(^|_)(at|date_created|date_updated|timestamp|last_access|last_used_at|expires)$|^(created|updated)(At|_at)?$/i;

/**
 * Makes two captures comparable: timestamps become <time:shape> (the value is dropped but
 * its format kept, so raw Postgres text where the frontend expects ISO still fails), ids minted during the scenario
 * become <new-1>, <new-2> in order of appearance (ids from the seed stay, since they carry
 * meaning), and ignored fields are dropped. Keys are sorted so order never counts.
 */
export function normalize(
  value: unknown,
  seedIds: ReadonlySet<string>,
  ignore: ReadonlySet<string>,
): unknown {
  const minted = new Map<string, string>();
  const walk = (v: unknown, key?: string): unknown => {
    if (key && ignore.has(key)) return "<ignored>";
    if (typeof v === "string") {
      if (key && VOLATILE_KEY.test(key) && ISO.test(v)) return timeShape(v);
      if (ISO.test(v) && !Number.isNaN(Date.parse(v))) return timeShape(v);
      return v.replace(UUID, (m) => {
        const low = m.toLowerCase();
        if (seedIds.has(low)) return low;
        if (!minted.has(low)) minted.set(low, `<new-${minted.size + 1}>`);
        return minted.get(low) as string;
      });
    }
    if (v instanceof Date) return "<time:date>";
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k], k)]),
      );
    }
    return v;
  };
  return walk(value);
}

/** The format of a timestamp without its value: digits become d. */
function timeShape(v: string): string {
  return `<time:${v.replace(/\d/g, "d")}>`;
}
