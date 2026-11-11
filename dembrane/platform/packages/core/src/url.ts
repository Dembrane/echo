/** A loop, not a regex: a regex over a configured URL is flagged as slow on many slashes. */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}
