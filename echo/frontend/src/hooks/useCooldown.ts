import { useEffect, useRef, useState } from "react";

export const useCooldown = (cooldownMs: number) => {
	const [lastTriggerTime, setLastTriggerTime] = useState<number | null>(null);
	const [timeRemaining, setTimeRemaining] = useState<number>(0);
	const timerRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		if (lastTriggerTime === null) return;

		const updateTimer = () => {
			const now = Date.now();
			const elapsed = now - lastTriggerTime;
			const remaining = Math.max(0, cooldownMs - elapsed);
			setTimeRemaining(remaining);
			if (remaining === 0 && timerRef.current) {
				clearInterval(timerRef.current);
				timerRef.current = null;
			}
		};

		updateTimer();
		timerRef.current = setInterval(updateTimer, 1000);

		return () => {
			if (timerRef.current) {
				clearInterval(timerRef.current);
				timerRef.current = null;
			}
		};
	}, [lastTriggerTime, cooldownMs]);

	return {
		isOnCooldown: timeRemaining > 0,
		timeRemaining,
		timeRemainingSeconds: Math.ceil(timeRemaining / 1000),
		trigger: () => setLastTriggerTime(Date.now()),
	};
};
