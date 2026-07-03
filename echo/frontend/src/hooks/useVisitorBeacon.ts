import { useEffect, useRef } from "react";

import { pingVisitor, type VisitorPingTelemetry } from "@/lib/api";
import {
	readBatteryTelemetry,
	readDeviceLabel,
	readNetworkTelemetry,
} from "@/lib/deviceTelemetry";
import { bumpScanCount, getVisitorId } from "@/lib/visitorId";

type BeaconArgs = {
	stage: string;
	name?: string | null;
	tags?: string[];
	tagsPreselected?: boolean;
	enabled?: boolean;
};

// Every 10s, matching the host funnel's expectation, plus an immediate beacon
// whenever the stage (or reported name/tags) changes.
const PING_INTERVAL_MS = 10000;

/**
 * Reports a portal visitor's funnel stage to the server while they onboard,
 * before any conversation exists. Keyed by a device-persistent visitor id so a
 * re-scan is recognised as the same dot.
 */
export const useVisitorBeacon = (
	projectId: string | undefined,
	{ stage, name, tags, tagsPreselected, enabled = true }: BeaconArgs,
): void => {
	const scanCountRef = useRef<number | null>(null);
	const tagsKey = (tags ?? []).join("|");

	// biome-ignore lint/correctness/useExhaustiveDependencies: tags is folded into tagsKey to keep a stable dep
	useEffect(() => {
		if (!enabled || !projectId) return;
		const visitorId = getVisitorId(projectId);
		if (scanCountRef.current === null) {
			scanCountRef.current = bumpScanCount(projectId);
		}
		let cancelled = false;
		const send = async () => {
			const battery = await readBatteryTelemetry();
			if (cancelled) return;
			const telemetry: VisitorPingTelemetry = {
				stage,
				name: name?.trim() || undefined,
				tags: tags && tags.length ? tags : undefined,
				tags_preselected: tagsPreselected || undefined,
				scan_count: scanCountRef.current ?? undefined,
				device: readDeviceLabel(),
				network: readNetworkTelemetry(),
				battery,
			};
			void pingVisitor(projectId, visitorId, telemetry);
		};
		void send();
		const interval = setInterval(() => void send(), PING_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [enabled, projectId, stage, name, tagsKey, tagsPreselected]);
};
