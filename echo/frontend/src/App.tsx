import "@fontsource-variable/space-grotesk";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/dropzone/styles.css";

import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { DatesProvider } from "@mantine/dates";
import { ModalsProvider } from "@mantine/modals";
import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { lazy, Suspense, useEffect } from "react";
import { RouterProvider } from "react-router/dom";
import { I18nProvider } from "./components/layout/I18nProvider";
import { USE_PARTICIPANT_ROUTER } from "./config";
import { detectAndEmitPilotBlock } from "./lib/pilotBlock";

// Reference import.meta.env directly so Vite can constant-fold the branch and
// Rollup can tree-shake the agentation chunk out of production builds. Through
// an intermediate constant the values would still be replaced, but the
// lazy(import(...)) call would remain reachable in the module graph.
const Agentation =
	import.meta.env.DEV || import.meta.env.VITE_ENABLE_AGENTATION === "1"
		? lazy(() => import("agentation").then((m) => ({ default: m.Agentation })))
		: null;

import type { PropsWithChildren } from "react";
import { AppPreferencesProvider } from "./hooks/useAppPreferences";
import { WhitelabelLogoProvider } from "./hooks/useWhitelabelLogo";
import { useWorkspaceProvider, WorkspaceContext } from "./hooks/useWorkspace";

function WorkspaceProvider({ children }: PropsWithChildren) {
	const value = useWorkspaceProvider(true);
	return (
		<WorkspaceContext.Provider value={value}>
			{children}
		</WorkspaceContext.Provider>
	);
}

import { analytics } from "./lib/analytics";
import { mainRouter, participantRouter } from "./Router";
import { theme } from "./theme";

// Pilot hard-block (matrix §8): intercept 402 + copy-locked body from
// host-side mutations and fan out a level-3 modal. Detection is
// copy-substring since we control both the backend body and the frontend
// match — see lib/pilotBlock.ts.
const queryClient = new QueryClient({
	mutationCache: new MutationCache({
		onError: (error) => {
			detectAndEmitPilotBlock(error);
		},
	}),
	queryCache: new QueryCache({
		onError: (error) => {
			detectAndEmitPilotBlock(error);
		},
	}),
});

const router = USE_PARTICIPANT_ROUTER ? participantRouter : mainRouter;

export const App = () => {
	useEffect(() => {
		const cleanup = analytics.enableAutoPageviews();

		return () => {
			cleanup();
		};
	}, []);

	useEffect(() => {
		const preloadRoutes = () => {
			const loaders = [
				() => import("./routes/project/ProjectsHome"),
				() =>
					import("./routes/project/conversation/ProjectConversationOverview"),
				() => import("./routes/project/ProjectRoutes"),
			];

			loaders.forEach((load) => {
				load().catch(() => {
					/* ignore preload errors */
				});
			});
		};

		let idleHandle: number | null = null;
		let timeoutId: number | null = null;

		const anyWindow = window as typeof window & {
			requestIdleCallback?: (
				cb: IdleRequestCallback,
				options?: IdleRequestOptions,
			) => number;
			cancelIdleCallback?: (handle: number) => void;
		};

		if (typeof anyWindow.requestIdleCallback === "function") {
			idleHandle = anyWindow.requestIdleCallback(preloadRoutes, {
				timeout: 1500,
			});
		} else {
			timeoutId = window.setTimeout(preloadRoutes, 1500);
		}

		return () => {
			if (
				idleHandle !== null &&
				typeof anyWindow.cancelIdleCallback === "function"
			) {
				anyWindow.cancelIdleCallback(idleHandle);
			}

			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
			}
		};
	}, []);

	return (
		<QueryClientProvider client={queryClient}>
			{/* <ReactQueryDevtools initialIsOpen={false} /> */}
			<MantineProvider theme={theme}>
				<DatesProvider settings={{ consistentWeeks: true }}>
					<AppPreferencesProvider>
						<WhitelabelLogoProvider>
							<WorkspaceProvider>
								{/* I18nProvider must wrap ModalsProvider: Mantine's
								    modal portal re-enters the tree outside any
								    non-context-aware ancestor, so <Trans> inside
								    modals.openConfirmModal children needs Lingui
								    context available from this level down. */}
								<I18nProvider>
									<ModalsProvider>
										<RouterProvider router={router} />
										{Agentation && (
											<Suspense fallback={null}>
												<Agentation />
											</Suspense>
										)}
									</ModalsProvider>
								</I18nProvider>
							</WorkspaceProvider>
						</WhitelabelLogoProvider>
					</AppPreferencesProvider>
				</DatesProvider>
			</MantineProvider>
		</QueryClientProvider>
	);
};
