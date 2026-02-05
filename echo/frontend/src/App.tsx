import "@fontsource-variable/space-grotesk";
import "@mantine/core/styles.css";
import "@mantine/dropzone/styles.css";

import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useEffect } from "react";
import { RouterProvider } from "react-router/dom";
import { I18nProvider } from "./components/layout/I18nProvider";
import { USE_PARTICIPANT_ROUTER } from "./config";
import { AppPreferencesProvider } from "./hooks/useAppPreferences";
import { analytics } from "./lib/analytics";
import { mainRouter, participantRouter } from "./Router";
import { theme } from "./theme";

const queryClient = new QueryClient();

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
				<AppPreferencesProvider>
					<I18nProvider>
						<RouterProvider router={router} />
					</I18nProvider>
				</AppPreferencesProvider>
			</MantineProvider>
		</QueryClientProvider>
	);
};
