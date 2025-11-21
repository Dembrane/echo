import { Box } from "@mantine/core";
import type { PropsWithChildren } from "react";
import { Outlet } from "react-router";
import { Toaster } from "../common/Toaster";
import { ErrorBoundary } from "../error/ErrorBoundary";
import { Header } from "./Header";
import { TransitionCurtainProvider } from "./TransitionCurtainProvider";

export const BaseLayout = ({ children }: PropsWithChildren) => {
	return (
		<TransitionCurtainProvider>
			<Box className="min-h-screen">
				<Box className="fixed top-0 z-10 w-full">
					<Header />
				</Box>

				<ErrorBoundary>
					<main className="h-base-layout-height pt-base-layout-padding w-full">
						<Outlet />
						{children}
					</main>
				</ErrorBoundary>

				<Toaster />
			</Box>
		</TransitionCurtainProvider>
	);
};
