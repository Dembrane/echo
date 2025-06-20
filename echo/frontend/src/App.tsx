import "@fontsource-variable/space-grotesk";
import "@mantine/core/styles.css";
import "@mantine/dropzone/styles.css";

import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { I18nProvider } from "./components/layout/I18nProvider";
import { mainRouter, participantRouter } from "./Router";
import { USE_PARTICIPANT_ROUTER } from "./config";
import { theme } from "./theme";
import { useEffect } from "react";
import { analytics } from "./lib/analytics";

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
      <MantineProvider theme={theme}>
        <I18nProvider>
          <RouterProvider router={router} />
        </I18nProvider>
      </MantineProvider>
    </QueryClientProvider>
  );
};
