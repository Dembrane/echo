import { Group, LoadingOverlay, Paper } from "@mantine/core";
import { type PropsWithChildren, useEffect } from "react";
import { Outlet, useLocation, useSearchParams } from "react-router";
import { useAuthenticated } from "@/components/auth/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { Logo } from "@/components/common/Logo";
import { LanguagePicker } from "@/components/language/LanguagePicker";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { Toaster } from "../common/Toaster";
import { Footer } from "./Footer";
import {
	TransitionCurtainProvider,
	useTransitionCurtain,
} from "./TransitionCurtainProvider";

const AuthHeader = () => (
	<Paper
		component="header"
		radius="0"
		shadow="xs"
		withBorder={false}
		className="z-30 w-full"
		style={{ backgroundColor: "var(--app-background)" }}
	>
		<Group justify="space-between" align="center" h={60} px="md">
			<I18nLink to="/">
				<Group align="center">
					<Logo hideTitle={false} alwaysDembrane />
				</Group>
			</I18nLink>
			<LanguagePicker />
		</Group>
	</Paper>
);

// Token-consuming routes render their own auth-aware UI; redirecting
// authed users away would race the token call (verify-email infinite-loading bug).
const SKIP_REDIRECT_PATHS = ["/verify-email", "/password-reset"];

export const AuthLayout = (props: PropsWithChildren) => (
	<TransitionCurtainProvider>
		<AuthLayoutInner {...props} />
	</TransitionCurtainProvider>
);

const AuthLayoutInner = (props: PropsWithChildren) => {
	const [query] = useSearchParams();
	const navigate = useI18nNavigate();
	const auth = useAuthenticated();
	const { isActive } = useTransitionCurtain();
	const location = useLocation();
	const skipRedirect = SKIP_REDIRECT_PATHS.some((p) =>
		location.pathname.endsWith(p),
	);

	useEffect(() => {
		if (auth.isAuthenticated && !isActive && !skipRedirect) {
			const nextLink = query.get("next") ?? "/o";
			navigate(nextLink);
		}
	}, [auth.isAuthenticated, isActive, navigate, query, skipRedirect]);

	return (
		<>
			<div
				className="relative flex min-h-dvh flex-col overflow-hidden lg:h-screen lg:flex lg:flex-row lg:items-stretch"
				style={{ backgroundColor: "var(--app-background)" }}
			>
				<LoadingOverlay visible={auth.loading} zIndex={2000} />
				<div className="flex w-full flex-1 flex-col lg:w-1/2 lg:min-h-screen lg:overflow-y-auto">
					<div
						className="border-b border-slate-200/60"
						style={{ backgroundColor: "var(--app-background)" }}
					>
						<AuthHeader />
					</div>
					<main className="flex flex-1 flex-col items-center justify-center px-6 py-12 sm:px-8 lg:px-14 lg:py-16">
						<div className="flex w-full max-w-md flex-col gap-8">
							<Outlet />
							{props.children}
						</div>
					</main>
					<div className="px-6 py-4 sm:px-8 lg:px-14">
						<Footer />
					</div>
				</div>
				<aside className="relative hidden h-full w-full flex-1 overflow-hidden lg:flex lg:min-h-screen">
					<video
						className="absolute inset-0 h-full w-full object-cover"
						src="/video/auth-hero.mp4"
						poster="/video/auth-hero-poster.jpg"
						autoPlay
						muted
						loop
						playsInline
						preload="auto"
					/>
					<div
						className="absolute inset-0 bg-white/45 backdrop-blur-md"
						aria-hidden="true"
					/>
					<div
						className="absolute inset-0 bg-gradient-to-br from-white/60 via-white/30 to-transparent"
						aria-hidden="true"
					/>
				</aside>
			</div>
			<Toaster />
		</>
	);
};
