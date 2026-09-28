import { expect, test } from "bun:test";
import { securityHeaders } from "../src/headers";

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
