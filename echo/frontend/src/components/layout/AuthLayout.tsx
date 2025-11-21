import { LoadingOverlay } from "@mantine/core";
import { type PropsWithChildren, useEffect } from "react";
import { Outlet, useSearchParams } from "react-router";
import { useAuthenticated } from "@/components/auth/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { Toaster } from "../common/Toaster";
import { Footer } from "./Footer";
import { HeaderView } from "./Header";
import {
	TransitionCurtainProvider,
	useTransitionCurtain,
} from "./TransitionCurtainProvider";

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

	useEffect(() => {
		if (auth.isAuthenticated && !isActive) {
			const nextLink = query.get("next") ?? "/projects";
			navigate(nextLink);
		}
	}, [auth.isAuthenticated, isActive, navigate, query]);

	return (
		<>
			<div className="relative flex min-h-dvh flex-col overflow-hidden bg-white lg:h-screen lg:flex lg:flex-row lg:items-stretch">
				<LoadingOverlay visible={auth.loading} zIndex={2000} />
				<div className="flex w-full flex-1 flex-col lg:w-1/2 lg:min-h-screen lg:overflow-y-auto">
					<div className="border-b border-slate-200/60 bg-white">
						<HeaderView
							isAuthenticated={auth.isAuthenticated}
							loading={auth.loading}
						/>
					</div>
					<main className="flex flex-1 flex-col items-center justify-center px-6 py-12 sm:px-8 lg:px-14 lg:py-16">
						<div className="flex w-full max-w-lg flex-col gap-8">
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
