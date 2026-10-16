// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pingVisitor = vi.fn();

vi.mock("@/lib/api", () => ({
	pingVisitor: (...a: unknown[]) => pingVisitor(...a),
}));
vi.mock("@/lib/deviceTelemetry", () => ({
	readBatteryTelemetry: async () => undefined,
	readDeviceLabel: () => "test",
	readNetworkTelemetry: () => undefined,
}));
vi.mock("@/lib/visitorId", () => ({
	bumpScanCount: () => 1,
	getVisitorId: () => "visitor-1",
}));

import { isKnownProjectId, useVisitorBeacon } from "./useVisitorBeacon";

describe("useVisitorBeacon", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		pingVisitor.mockClear();
	});
	afterEach(() => vi.useRealTimers());

	it("sends nothing while the project id is not known", async () => {
		for (const id of [undefined, "", "undefined", "null"]) {
			renderHook(() => useVisitorBeacon(id, { stage: "scanned" }));
		}
		await vi.advanceTimersByTimeAsync(35000);
		expect(pingVisitor).not.toHaveBeenCalled();
	});

	it("pings at once and every 10 seconds for a real id", async () => {
		renderHook(() => useVisitorBeacon("p-1", { stage: "scanned" }));
		await vi.advanceTimersByTimeAsync(10000);
		expect(pingVisitor).toHaveBeenCalledTimes(2);
		expect(pingVisitor.mock.calls[0][0]).toBe("p-1");
	});

	it("knows a real id from a placeholder", () => {
		expect(isKnownProjectId("01a14418-b815-762d-99e2-ef9dd0f695eb")).toBe(true);
		expect(isKnownProjectId("undefined")).toBe(false);
	});
});
