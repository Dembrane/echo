import { useLingui } from "@lingui/react";
import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

type TransitionOptions = {
	message?: string;
	description?: string | null;
	dramatic?: boolean; // For theme changes - longer, more dramatic
};

type TransitionCurtainContextValue = {
	runTransition: (options?: TransitionOptions) => Promise<void>;
	isActive: boolean;
};

const TransitionCurtainContext =
	createContext<TransitionCurtainContextValue | null>(null);

export const useTransitionCurtain = () => {
	const value = useContext(TransitionCurtainContext);
	if (!value) {
		throw new Error(
			"useTransitionCurtain must be used within TransitionCurtainProvider",
		);
	}
	return value;
};

export const TransitionCurtainProvider = ({ children }: PropsWithChildren) => {
	const [isActive, setIsActive] = useState(false);
	const [hasEntered, setHasEntered] = useState(false);
	const [isDramatic, setIsDramatic] = useState(false);
	const [message, setMessage] = useState<string | undefined>(undefined);
	const [description, setDescription] = useState<string | null | undefined>(
		undefined,
	);
	const settleTimerRef = useRef<number | null>(null);
	const fadeTimerRef = useRef<number | null>(null);
	const cleanupTimerRef = useRef<number | null>(null);
	const pendingResolveRef = useRef<(() => void) | null>(null);

	const runTransition = useCallback(
		(options?: TransitionOptions) => {
			const normalizedMessage = options?.message?.trim() || undefined;
			const normalizedDescription =
				options?.description === undefined
					? undefined
					: options.description === null
						? null
						: options.description.trim() || undefined;
			const dramatic = options?.dramatic ?? false;

			if (isActive) {
				return new Promise<void>((resolve) => {
					const previous = pendingResolveRef.current;
					pendingResolveRef.current = () => {
						previous?.();
						resolve();
					};
				});
			}

			// Timing adjustments for dramatic mode
			const settleTime = dramatic ? 2200 : 1600;
			const fadeTime = dramatic ? 3000 : 2200;
			const cleanupTime = dramatic ? 600 : 400;

			return new Promise<void>((resolve) => {
				pendingResolveRef.current = resolve;

				if (settleTimerRef.current !== null) {
					window.clearTimeout(settleTimerRef.current);
				}
				if (fadeTimerRef.current !== null) {
					window.clearTimeout(fadeTimerRef.current);
				}
				if (cleanupTimerRef.current !== null) {
					window.clearTimeout(cleanupTimerRef.current);
				}

				setMessage(normalizedMessage);
				setDescription(normalizedDescription);
				setIsDramatic(dramatic);
				setIsActive(true);
				requestAnimationFrame(() => {
					setHasEntered(true);
				});

				settleTimerRef.current = window.setTimeout(() => {
					pendingResolveRef.current?.();
					pendingResolveRef.current = null;
				}, settleTime);

				fadeTimerRef.current = window.setTimeout(() => {
					setHasEntered(false);
					cleanupTimerRef.current = window.setTimeout(() => {
						setIsActive(false);
						setMessage(undefined);
						setDescription(undefined);
						setIsDramatic(false);
					}, cleanupTime);
				}, fadeTime);
			});
		},
		[isActive],
	);

	useEffect(() => {
		return () => {
			if (settleTimerRef.current !== null) {
				window.clearTimeout(settleTimerRef.current);
			}
			if (fadeTimerRef.current !== null) {
				window.clearTimeout(fadeTimerRef.current);
			}
			if (cleanupTimerRef.current !== null) {
				window.clearTimeout(cleanupTimerRef.current);
			}
			pendingResolveRef.current?.();
		};
	}, []);

	// Prevent page scrolling while transition curtain is visible
	useEffect(() => {
		if (isActive) {
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "";
		}

		return () => {
			document.body.style.overflow = "";
		};
	}, [isActive]);

	const contextValue = useMemo(
		(): TransitionCurtainContextValue => ({
			isActive,
			runTransition,
		}),
		[isActive, runTransition],
	);

	const { i18n } = useLingui();
	const resolvedDescription =
		description === null
			? null
			: (description ?? i18n._("We're preparing your workspace."));

	return (
		<TransitionCurtainContext.Provider value={contextValue}>
			{children}
			{isActive && (
				<div
					className={`fixed inset-0 z-[100] overflow-hidden transition-opacity ${isDramatic ? "duration-700" : "duration-500"} ${hasEntered ? "opacity-100" : "opacity-0"}`}
				>
					<video
						src="/video/auth-hero.mp4"
						poster="/video/auth-hero-poster.jpg"
						autoPlay
						muted
						loop
						playsInline
						className={`absolute inset-0 h-full w-full object-cover transition-transform ${isDramatic ? "duration-[2000ms]" : "duration-[1400ms]"} ease-out ${hasEntered ? "scale-100" : "scale-110"}`}
					/>
					<div
						className={`absolute inset-0 backdrop-blur-3xl transition-all ${isDramatic ? "duration-1000" : "duration-700"} ease-out ${hasEntered ? "opacity-100" : "opacity-40"}`}
						style={{
							backgroundColor:
								"color-mix(in srgb, var(--app-background) 55%, transparent)",
						}}
					/>
					<div
						className={`relative z-10 flex h-full w-full flex-col items-center justify-center px-6 text-center transition-all ${isDramatic ? "duration-1000" : "duration-700"} ease-out ${hasEntered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
					>
						{isDramatic ? (
							<p
								className="font-semibold text-3xl sm:text-4xl whitespace-nowrap"
								style={{ color: "var(--app-text, #1e293b)" }}
							>
								{i18n._("Preparing your dashboard")}
							</p>
						) : (
							<div className="mx-auto max-w-xl space-y-4">
								<p
									className="font-semibold text-3xl sm:text-4xl"
									style={{ color: "var(--app-text, #1e293b)" }}
								>
									{message ?? i18n._("Welcome back")}
								</p>
								{resolvedDescription && (
									<p
										className="text-base"
										style={{ color: "var(--app-text, #475569)", opacity: 0.8 }}
									>
										{resolvedDescription}
									</p>
								)}
							</div>
						)}
					</div>
				</div>
			)}
		</TransitionCurtainContext.Provider>
	);
};
