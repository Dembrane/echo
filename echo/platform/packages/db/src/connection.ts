import postgres from "postgres";

/**
 * Opens postgres.js from a connection URL. Cloud Run reaches Cloud SQL through a unix
 * socket written as `?host=/cloudsql/<instance>` (the form node-postgres and pg-boss
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
