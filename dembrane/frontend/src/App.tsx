import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/dropzone/styles.css";

import { MantineProvider } from "@mantine/core";
import { IconContext } from "@phosphor-icons/react";
import "@mantine/core/styles.css";
import { DatesProvider } from "@mantine/dates";
import { ModalsProvider } from "@mantine/modals";
import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { lazy, Suspense, useEffect } from "react";
import { RouterProvider } from "react-router/dom";
import { LoadingStage } from "./components/common/BeautifulLoading";
import { notifyError } from "./components/error/notifyError";
import { I18nProvider } from "./components/layout/I18nProvider";
import { ENABLE_AGENTATION, USE_PARTICIPANT_ROUTER } from "./config";
import { watchForNewVersion } from "./lib/appVersion";
import { errorCode, readApiError } from "./lib/errors/read";
import { detectAndEmitPilotBlock } from "./lib/pilotBlock";

// Gated at runtime by ENABLE_AGENTATION (config.ts), not at build time, so no
// per-deploy env var is needed. The chunk stays lazy: environments where the
// gate is off (production) never render it, so the browser never downloads it.
const Agentation = lazy(() =>
	import("agentation").then((m) => ({ default: m.Agentation })),
);

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

import { mainRouter, participantRouter } from "./Router";
import { cssVariablesResolver, theme } from "./theme";

// Pilot hard-block (matrix §8): intercept 402 + copy-locked body from
// host-side mutations and fan out a level-3 modal. Detection is
// copy-substring since we control both the backend body and the frontend
// match — see lib/pilotBlock.ts.
// The query layer's side of the error presenter (lib/errors): a mutation that handles
// none of its own errors gets the friendly toast with its action, and a query whose
// session ran out says so once, with a sign-in button. Screens that show an error inline
// (ErrorNotice) pass `meta: { errorToast: false }` or their own onError.
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// A refused request (an ended session, a missing project, no access) answers the
			// same way on every retry: say so at once instead of after three backoffs.
			retry: (failures, error) => {
				const status = readApiError(error).status;
				if (
					status &&
					status >= 400 &&
					status < 500 &&
					![408, 429].includes(status)
				)
					return false;
				return failures < 3;
			},
		},
	},
	mutationCache: new MutationCache({
		onError: (error, _variables, _context, mutation) => {
			if (detectAndEmitPilotBlock(error)) return;
			if (mutation.options.onError) return;
			if (mutation.meta?.errorToast === false) return;
			void notifyError(error);
		},
	}),
	queryCache: new QueryCache({
		onError: (error) => {
			detectAndEmitPilotBlock(error);
			if (errorCode(error) === "auth.session_expired") void notifyError(error);
		},
	}),
});

const router = USE_PARTICIPANT_ROUTER ? participantRouter : mainRouter;
const audienceEntry = /^\/present\/(screen|public)\//.test(
	window.location.pathname,
);

export const App = () => {
	// Pageviews (including SPA history changes) are captured by PostHog via
	// the `defaults` option in posthog.init (src/main.tsx).

	useEffect(() => watchForNewVersion(router), []);

	useEffect(() => {
		if (audienceEntry) return;
		const preloadRoutes = () => {
			const loaders = [
				() => import("./routes/project/ProjectsHome"),
				() => import("./routes/project/conversation/ProjectConversationRoute"),
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

	if (audienceEntry) {
		return (
			<QueryClientProvider client={queryClient}>
				<MantineProvider
					theme={theme}
					cssVariablesResolver={cssVariablesResolver}
				>
					<IconContext.Provider value={{ weight: "light" }}>
						<I18nProvider>
							<RouterProvider router={router} />
						</I18nProvider>
					</IconContext.Provider>
					<LoadingStage />
				</MantineProvider>
			</QueryClientProvider>
		);
	}

	return (
		<QueryClientProvider client={queryClient}>
			{/* <ReactQueryDevtools initialIsOpen={false} /> */}
			<MantineProvider
				theme={theme}
				cssVariablesResolver={cssVariablesResolver}
			>
				{/* Phosphor's light cut, topped up to the one 1px stroke in rules.css */}
				<IconContext.Provider value={{ weight: "light" }}>
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
											{ENABLE_AGENTATION && (
												<Suspense fallback={null}>
													<Agentation />
												</Suspense>
											)}
										</ModalsProvider>
									</I18nProvider>
									<LoadingStage />
								</WorkspaceProvider>
							</WhitelabelLogoProvider>
						</AppPreferencesProvider>
					</DatesProvider>
				</IconContext.Provider>
			</MantineProvider>
		</QueryClientProvider>
	);
};
