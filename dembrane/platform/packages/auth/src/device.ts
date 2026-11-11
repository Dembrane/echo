/** Coarse labels from the reported user agent, never used to establish identity or trust. */
export function browserDetails(agent: string | null) {
  const ua = agent ?? "";
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /(?:OPR|Opera)\//.test(ua)
      ? "Opera"
      : /(?:Firefox|FxiOS)\//.test(ua)
        ? "Firefox"
        : /(?:Chrome|CriOS)\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const platform = /iPhone|iPod/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return { browser, platform };
}
