import { expect, test } from "bun:test";
import { securityHeaders } from "../src/headers";
import { withoutTally } from "../src/server";

// The booking step (frontend PricingBookingStep) and the account page's "Book a call" load
// cal.com's inline embed: its script, its iframe, and its calls back to app.cal.com. The
// step falls back to a plain link when the CSP blocks any of these, so this keeps the embed on.
test("the CSP lets the cal.com embed load, frame and connect", () => {
  const csp = securityHeaders({ own: ["https://dash.example"], storage: [] })[
    "Content-Security-Policy"
  ] as string;
  const directive = (name: string) =>
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? "";
  for (const name of ["script-src", "frame-src", "connect-src"])
    expect(directive(name).split(" ")).toContain("https://app.cal.com");
});

test("analytics off drops PostHog and Tally from the CSP, and storage origins come from input", () => {
  const on = securityHeaders({ own: ["https://d.example"], storage: [] })[
    "Content-Security-Policy"
  ];
  expect(on).toContain("posthog.com");
  expect(on).toContain("tally.so");
  const off = securityHeaders({
    own: ["https://d.example"],
    storage: ["https://*.s3.fr-par.scw.cloud"],
    analytics: false,
  })["Content-Security-Policy"] as string;
  expect(off).not.toContain("posthog");
  expect(off).not.toContain("tally.so");
  expect(off).not.toContain("r.dembrane.com");
  expect(off).toContain("https://*.s3.fr-par.scw.cloud");
  expect(off).toContain("https://app.cal.com");
});

test("the Tally script is removed from the page when analytics is off", () => {
  const html = `<head>\n    <script src="https://tally.so/widgets/embed.js"></script>\n    <title>x</title>\n</head>`;
  expect(withoutTally(html)).toBe("<head>\n    <title>x</title>\n</head>");
});
