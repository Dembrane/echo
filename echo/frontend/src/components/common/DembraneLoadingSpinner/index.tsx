import { t } from "@lingui/core/macro";
import type React from "react";
import { useEffect, useState } from "react";
import "./DembraneLoading.css";
import { cn } from "@/lib/utils";
import dembraneLogoHQ from "../../../assets/dembrane-logo-hq.png";

interface DembraneLoadingSpinnerProps {
	isLoading: boolean;
	showMessage?: boolean;
	className?: string;
}

const DembraneLoadingSpinner: React.FC<DembraneLoadingSpinnerProps> = ({
	isLoading,
	className,
	showMessage = true,
}) => {
	const [messageIndex, setMessageIndex] = useState(0);
	const [visible, setVisible] = useState(true);

	const messages = [
		t`Welcome to Dembrane!`,
		t`Loading`,
		t`Preparing your experience`,
		t`Almost there`,
		t`Just a moment`,
	];

	useEffect(() => {
		const interval = setInterval(() => {
			setMessageIndex((index) => (index + 1) % messages.length);
		}, 3000); // Change message every 3 seconds

		return () => clearInterval(interval);
	}, []);

	useEffect(() => {
		if (!isLoading) {
			// Delay the fade-out animation by 1 second
			const timer = setTimeout(() => {
				setVisible(false);
			}, 2500); // 2000ms (2 second) delay + 500ms for fade-out animation

			return () => clearTimeout(timer);
		}
	}, [isLoading]);

	if (!visible) {
		return null;
	}

	return (
		<div
			className={cn(
				"loading-container fixed inset-0 z-10 flex flex-col items-center justify-center transition-opacity duration-500",
				{
					"opacity-0": !isLoading,
					"opacity-100": isLoading,
				},
			)}
		>
			<img
				src={dembraneLogoHQ}
				alt="Spinning Dembrane Logo to indicate loading"
				className={cn("loading-image h-12 w-12 animate-spin", className)}
			/>
			{showMessage && <p className="mt-4 text-lg">{messages[messageIndex]}</p>}
		</div>
	);
};

export default DembraneLoadingSpinner;
