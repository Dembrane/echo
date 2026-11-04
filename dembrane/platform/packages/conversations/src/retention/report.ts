import type { OrgReport, RetentionReport } from "./run";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "-");
const mb = (n: number | null) => (n === null ? "-" : `${(n / 1_000_000).toFixed(1)} MB`);
const num = (n: number | null) => (n === null ? "-" : String(n));

export function totals(orgs: readonly OrgReport[]) {
  const sum = (f: (o: OrgReport) => number | null) =>
    orgs.some((o) => f(o) !== null) ? orgs.reduce((a, o) => a + (f(o) ?? 0), 0) : null;
  const oldest = orgs.flatMap((o) => (o.oldest ? [o.oldest.getTime()] : []));
  return {
    conversations: sum((o) => o.conversations) as number,
    pathsInRows: sum((o) => o.pathsInRows) as number,
    objects: sum((o) => o.objects),
    bytes: sum((o) => o.bytes),
    noncurrentVersions: sum((o) => o.noncurrentVersions),
    noncurrentBytes: sum((o) => o.noncurrentBytes),
    heldBack: sum((o) => o.heldBack) as number,
    oldest: oldest.length ? new Date(Math.min(...oldest)) : null,
  };
}

/** The dry run as plain text, one line per organisation. Nothing in it has been removed. */
export function formatReport(r: RetentionReport): string {
  const head = [
    "organisation",
    "keep days",
    "conversations",
    "objects",
    "bytes",
    "old versions",
    "old version bytes",
    "oldest",
    "kept (shared)",
  ];
  const line = (name: string, days: string, x: ReturnType<typeof totals>) => [
    name,
    days,
    String(x.conversations),
    num(x.objects),
    mb(x.bytes),
    num(x.noncurrentVersions),
    mb(x.noncurrentBytes),
    day(x.oldest),
    String(x.heldBack),
  ];
  const rows = [
    head,
    ...r.orgs.map((o) =>
      line(o.orgName, r.step === "aged" ? String(o.retentionDays) : "-", totals([o])),
    ),
    line("TOTAL", "", totals(r.orgs)),
  ];
  const width = head.map((_, i) => Math.max(...rows.map((row) => (row[i] as string).length)));
  const table = rows.map((row) =>
    row
      .map((c, i) => c.padEnd(width[i] as number))
      .join("  ")
      .trimEnd(),
  );
  return [
    `Dry run, step "${r.step}". Nothing was removed.`,
    r.bucketRead
      ? `Bucket read; versioning ${r.versioning}. Objects and bytes are what the step would remove.`
      : "Database only: the bucket was not read, so bytes and old versions are not counted; oldest is the oldest chunk the rows record.",
    "",
    ...table,
  ].join("\n");
}
