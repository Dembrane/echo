import "@fontsource-variable/space-grotesk";
import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { WorkspaceMethodologiesSection } from "@/components/methodology/WorkspaceMethodologiesSection";
import { theme } from "@/theme";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: false,
		},
	},
});

createRoot(document.getElementById("root") as HTMLElement).render(
	<QueryClientProvider client={queryClient}>
		<MantineProvider theme={theme}>
			<I18nProvider>
				<ModalsProvider>
					<main style={{ maxWidth: 900, padding: 24 }}>
						<WorkspaceMethodologiesSection workspaceId="workspace-harness" />
					</main>
					<Toaster />
				</ModalsProvider>
			</I18nProvider>
		</MantineProvider>
	</QueryClientProvider>,
);
