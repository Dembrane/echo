// Best-effort device telemetry for the host monitor. The Network Information
// and Battery Status APIs are not on every browser (Safari/Firefox lack
// Battery entirely), so each degrades to `undefined` and is simply omitted.

export type NetworkTelemetry = {
	online?: boolean;
	effective_type?: string;
	downlink?: number;
	rtt?: number;
};

export type BatteryTelemetry = {
	level?: number;
	charging?: boolean;
};

export const readNetworkTelemetry = (): NetworkTelemetry | undefined => {
	const nav = navigator as Navigator & {
		connection?: { effectiveType?: string; downlink?: number; rtt?: number };
	};
	const conn = nav.connection;
	const online =
		typeof navigator.onLine === "boolean" ? navigator.onLine : undefined;
	if (!conn && online === undefined) return undefined;
	return {
		online,
		effective_type: conn?.effectiveType,
		downlink: conn?.downlink,
		rtt: conn?.rtt,
	};
};

export const readBatteryTelemetry = async (): Promise<
	BatteryTelemetry | undefined
> => {
	const nav = navigator as Navigator & {
		getBattery?: () => Promise<{ level: number; charging: boolean }>;
	};
	if (typeof nav.getBattery !== "function") return undefined;
	try {
		const battery = await nav.getBattery();
		return { level: battery.level, charging: battery.charging };
	} catch {
		return undefined;
	}
};

// A short, human-readable device hint (browser + platform) for the host's
// diagnostic drilldown — never a full fingerprint.
export const readDeviceLabel = (): string | undefined => {
	const ua = navigator.userAgent;
	if (!ua) return undefined;
	const browser = /edg/i.test(ua)
		? "Edge"
		: /chrome|crios/i.test(ua)
			? "Chrome"
			: /firefox|fxios/i.test(ua)
				? "Firefox"
				: /safari/i.test(ua)
					? "Safari"
					: "Browser";
	const platform = /iphone|ipad|ipod/i.test(ua)
		? "iOS"
		: /android/i.test(ua)
			? "Android"
			: /mac/i.test(ua)
				? "Mac"
				: /win/i.test(ua)
					? "Windows"
					: "";
	return platform ? `${browser} · ${platform}` : browser;
};
