import { useEffect, useState } from "react";

const COOLDOWN_DURATION = 2 * 60 * 1000; // 2 minutes in milliseconds

type CooldownType = "verify" | "echo";

type CooldownState = {
	isActive: boolean;
	progress: number;
	remaining: number;
};

const getStorageKey = (conversationId: string, type: CooldownType) =>
	`cooldown_${conversationId}_${type}`;

const getCooldownState = (
	conversationId: string,
	type: CooldownType,
): CooldownState => {
	const key = getStorageKey(conversationId, type);
	const timestamp = localStorage.getItem(key);
	if (!timestamp) return { isActive: false, progress: 0, remaining: 0 };

	const lastClick = Number.parseInt(timestamp, 10);
	const now = Date.now();
	const elapsed = now - lastClick;
	const remaining = COOLDOWN_DURATION - elapsed;

	if (remaining <= 0) {
		localStorage.removeItem(key);
		return { isActive: false, progress: 0, remaining: 0 };
	}

	const progress = (elapsed / COOLDOWN_DURATION) * 100;
	return { isActive: true, progress, remaining };
};

const formatTime = (milliseconds: number): string => {
	const totalSeconds = Math.ceil(milliseconds / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export const startCooldown = (conversationId: string, type: CooldownType) => {
	localStorage.setItem(
		getStorageKey(conversationId, type),
		Date.now().toString(),
	);
};

export const useRefineSelectionCooldown = (
	conversationId: string | undefined,
) => {
	const [verifyCooldown, setVerifyCooldown] = useState<CooldownState>(() =>
		getCooldownState(conversationId ?? "", "verify"),
	);
	const [echoCooldown, setEchoCooldown] = useState<CooldownState>(() =>
		getCooldownState(conversationId ?? "", "echo"),
	);

	// Update cooldown state every second
	useEffect(() => {
		if (!conversationId) return;

		const interval = setInterval(() => {
			setVerifyCooldown(getCooldownState(conversationId, "verify"));
			setEchoCooldown(getCooldownState(conversationId, "echo"));
		}, 1000);

		return () => clearInterval(interval);
	}, [conversationId]);

	return {
		echo: {
			...echoCooldown,
			formattedTime: formatTime(echoCooldown.remaining),
		},
		startEchoCooldown: () => {
			if (conversationId) {
				startCooldown(conversationId, "echo");
			}
		},
		verify: {
			...verifyCooldown,
			formattedTime: formatTime(verifyCooldown.remaining),
		},
	};
};
