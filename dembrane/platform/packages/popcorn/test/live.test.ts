import { describe, expect, test } from "bun:test";
import {
  InvalidHours,
  InvalidReadyBy,
  liveBooking,
  liveWindow,
  READY_LEAD_MS,
  withoutBooking,
} from "../src/service";

const now = new Date("2026-10-06T12:00:00Z");
const at = (iso: string) => new Date(iso);

describe("liveWindow", () => {
  test("without a time it starts now and runs the hours from now", () => {
    expect(liveWindow(now, 8)).toEqual({
      startsAt: now,
      expiresAt: at("2026-10-06T20:00:00Z"),
      booked: false,
    });
  });

  test("Ready by books the first read 15 minutes before the time, live for the hours from then", () => {
    expect(READY_LEAD_MS).toBe(15 * 60_000);
    expect(liveWindow(now, 8, at("2026-10-06T14:30:00Z"))).toEqual({
      startsAt: at("2026-10-06T14:15:00Z"),
      expiresAt: at("2026-10-06T22:15:00Z"),
      booked: true,
    });
  });

  test("a time less than 15 minutes out starts now", () => {
    expect(liveWindow(now, 1, at("2026-10-06T12:10:00Z"))).toEqual({
      startsAt: now,
      expiresAt: at("2026-10-06T13:00:00Z"),
      booked: false,
    });
  });

  test("a time that has passed, or is more than 7 days out, is refused", () => {
    expect(() => liveWindow(now, 8, at("2026-10-06T11:59:00Z"))).toThrow(InvalidReadyBy);
    expect(() => liveWindow(now, 8, now)).toThrow(InvalidReadyBy);
    expect(() => liveWindow(now, 8, at("2026-10-13T12:01:00Z"))).toThrow(InvalidReadyBy);
    expect(() => liveWindow(now, 8, new Date(Number.NaN))).toThrow(InvalidReadyBy);
    expect(liveWindow(now, 8, at("2026-10-13T12:00:00Z")).booked).toBe(true);
  });

  test("the hours stay one of the offered durations", () => {
    expect(() => liveWindow(now, 5, at("2026-10-06T14:30:00Z"))).toThrow(InvalidHours);
  });
});

describe("the booking in the loop's caps", () => {
  const caps = {
    kind: "popcorn",
    ready_by: "2026-10-06T14:30:00+00:00",
    starts_at: "2026-10-06T14:15:00+00:00",
  };

  test("a manual loop shows its booking; a live one has none", () => {
    expect(liveBooking({ status: "paused", caps })).toEqual({
      readyBy: caps.ready_by,
      startsAt: caps.starts_at,
    });
    expect(liveBooking({ status: "active", caps })).toBeNull();
    expect(liveBooking({ status: "paused", caps: { kind: "popcorn" } })).toBeNull();
  });

  test("removing it keeps the kind", () => {
    expect(withoutBooking(caps)).toEqual({ kind: "popcorn" });
    expect(withoutBooking(null)).toEqual({ kind: "popcorn" });
  });
});
