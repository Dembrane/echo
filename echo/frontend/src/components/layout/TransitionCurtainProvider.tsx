import { useLingui } from "@lingui/react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PropsWithChildren,
} from "react";

type TransitionOptions = {
	message?: string;
	description?: string | null;
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

export const TransitionCurtainProvider = ({
	children,
}: PropsWithChildren) => {
	const [isActive, setIsActive] = useState(false);
	const [hasEntered, setHasEntered] = useState(false);
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

			if (isActive) {
				return new Promise<void>((resolve) => {
					const previous = pendingResolveRef.current;
					pendingResolveRef.current = () => {
						previous?.();
						resolve();
					};
				});
			}

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
				setIsActive(true);
				requestAnimationFrame(() => {
					setHasEntered(true);
				});

				settleTimerRef.current = window.setTimeout(() => {
					pendingResolveRef.current?.();
					pendingResolveRef.current = null;
				}, 1600);

				fadeTimerRef.current = window.setTimeout(() => {
					setHasEntered(false);
					cleanupTimerRef.current = window.setTimeout(() => {
						setIsActive(false);
						setMessage(undefined);
						setDescription(undefined);
					}, 400);
				}, 2200);
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

	const contextValue = useMemo(
		(): TransitionCurtainContextValue => ({
			runTransition,
			isActive,
		}),
		[isActive, runTransition],
	);

	const { i18n } = useLingui();
	const resolvedDescription =
		description === null
			? null
			: description ?? i18n._("We're preparing your workspace.");

	return (
		<TransitionCurtainContext.Provider value={contextValue}>
			{children}
			{isActive && (
				<div
					className={`fixed inset-0 z-[100] overflow-hidden transition-opacity duration-500 ${hasEntered ? "opacity-100" : "opacity-0"}`}
				>
					<video
						src="/video/auth-hero.mp4"
						poster="/video/auth-hero-poster.jpg"
						autoPlay
						muted
						loop
						playsInline
						className={`absolute inset-0 h-full w-full object-cover transition-transform duration-[1400ms] ease-out ${hasEntered ? "scale-100" : "scale-110"}`}
					/>
					<div
						className={`absolute inset-0 bg-white/55 backdrop-blur-3xl transition-opacity duration-700 ease-out ${hasEntered ? "opacity-100" : "opacity-40"}`}
					/>
					<div
						className={`relative z-10 flex h-full w-full flex-col items-center justify-center px-6 text-center transition-opacity duration-700 ease-out ${hasEntered ? "opacity-100" : "opacity-0"}`}
					>
						<div className="mx-auto max-w-xl space-y-4">
							<p className="text-3xl font-semibold text-slate-900 sm:text-4xl">
								{message ?? i18n._("Welcome back")}
							</p>
							{resolvedDescription && (
								<p className="text-base text-slate-700">{resolvedDescription}</p>
							)}
						</div>
					</div>
				</div>
			)}
		</TransitionCurtainContext.Provider>
	);
};
