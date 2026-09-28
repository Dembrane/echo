import postgres from "postgres";

/**
 * Opens postgres.js from a connection URL. Cloud Run reaches Cloud SQL through a unix
 * socket written as `?host=/cloudsql/<instance>` (the form node-postgres and DBOS
 * read); postgres.js needs that as an explicit socket path, so it is translated here once.
 */
export function connect(
  url: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
) {
  const u = new URL(url);
  const socketDir = u.searchParams.get("host");
  if (socketDir?.startsWith("/")) {
    u.searchParams.delete("host");
    return postgres(u.toString(), { ...options, path: `${socketDir}/.s.PGSQL.${u.port || 5432}` });
  }
  return postgres(url, options);
}

export interface DbFailure {
  /** Which part of reaching the database failed. */
  readonly cause: "socket" | "host" | "auth" | "database" | "capacity" | "unknown";
  /** Where the URL points, without credentials: the socket path or host:port, and the database. */
  readonly target: string;
  /** The driver's own words, from the innermost error. */
  readonly detail: string;
  /** One line a person on call can act on. */
  readonly message: string;
}

const AUTH_CODES = new Set(["28P01", "28000"]);
const HOST_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "CONNECT_TIMEOUT",
]);

/**
 * Names why a process could not reach Postgres: a Cloud SQL socket that is missing or
 * refused, a host that does not answer, a login the server rejects, a missing database
 * or a full server. Returns null for errors that are not about reaching the database,
 * so a boot failure elsewhere keeps its own report.
 */
export function describeDbFailure(err: unknown, url: string): DbFailure | null {
  const chain: Record<string, unknown>[] = [];
  // DBOS wraps the driver's error in `error`, others in `cause`.
  for (
    let e = err;
    e && typeof e === "object" && chain.length < 5;
    e = (e as { cause?: unknown; error?: unknown }).cause ?? (e as { error?: unknown }).error
  )
    chain.push(e as Record<string, unknown>);
  const hit = chain.findLast((e) => typeof e.code === "string") ?? chain.at(-1);
  if (!hit) return null;
  const code = String(hit.code ?? "");
  const detail = String(hit.message ?? err);

  let target = "an unparseable DATABASE_URL";
  let socket: string | null = null;
  try {
    const u = new URL(url);
    const dir = u.searchParams.get("host");
    const port = u.port || "5432";
    socket = dir?.startsWith("/") ? `${dir}/.s.PGSQL.${port}` : null;
    target = `${socket ? `socket ${socket}` : `host ${u.hostname}:${port}`}, database ${u.pathname.slice(1) || "(default)"}, user ${decodeURIComponent(u.username) || "(default)"}`;
  } catch {}

  const dialed = typeof hit.address === "string" ? `${hit.address}:${hit.port ?? ""}` : null;
  const say = (cause: DbFailure["cause"], why: string): DbFailure => ({
    cause,
    target,
    detail,
    message: `cannot reach the database (${cause}): ${why}. Target: ${target}. Driver: ${detail}`,
  });

  if (AUTH_CODES.has(code))
    return say("auth", "the server rejected the login; check the password secret and the role");
  if (code === "3D000") return say("database", "the database does not exist; run the migrate job");
  if (code === "53300" || code === "57P03")
    return say(
      "capacity",
      "the server refused more connections; check pool sizes against max_connections",
    );
  if (socket && dialed)
    return say(
      "socket",
      `the URL names a Cloud SQL socket but a client dialed TCP ${dialed}; it must open the URL through connect()`,
    );
  if (socket && (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES"))
    return say(
      "socket",
      "the Cloud SQL socket is missing or refused; check --add-cloudsql-instances and the instance name",
    );
  if (HOST_CODES.has(code))
    return say(
      "host",
      `nothing answered${dialed ? ` at ${dialed}` : ""}; check the host, port and network path`,
    );
  if (/connect|system database/i.test(detail)) return say("unknown", "the connection failed");
  return null;
}
