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
	return (
		<QueryClientProvider client={queryClient}>
			<ReactQueryDevtools initialIsOpen={false} />
			<MantineProvider theme={theme}>
				<I18nProvider>
					<RouterProvider router={router} />
				</I18nProvider>
			</MantineProvider>
		</QueryClientProvider>
	);
};
