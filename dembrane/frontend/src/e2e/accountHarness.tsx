import "@mantine/core/styles.css";
import "@/index.css";

import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { AccountRoute } from "@/features/accounts/customer/AccountRoute";
import { AccountCardRoute } from "@/features/accounts/staff/AccountCardRoute";
import { cssVariablesResolver, theme } from "@/theme";

// The customer account page on the fixture backend (VITE_ACCOUNTS_FIXTURES=1), outside
// the signed-in shell, for screenshots. ?path= picks the route.
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const path =
	new URLSearchParams(window.location.search).get("path") ??
	"/en-US/o/5f1a2b3c-0d4e-4f60-8a71-92b3c4d5e6f7/account";
// The staff card asks who is looking; the harness answers "staff".
if (path.includes("/admin/")) {
	queryClient.setQueryData(["v2", "me"], {
		display_name: "Staff",
		email: "staff@dembrane.com",
		is_staff: true,
	});
}
const router = createMemoryRouter(
	[
		{ element: <AccountRoute />, path: "/:language/o/:organisationId/account" },
		{ element: <AccountCardRoute />, path: "/:language/admin/accounts/:orgId" },
	],
	{ initialEntries: [path] },
);

createRoot(document.getElementById("root") as HTMLElement).render(
	<QueryClientProvider client={queryClient}>
		<MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
			<I18nProvider>
				<ModalsProvider>
					<RouterProvider router={router} />
					<Toaster />
				</ModalsProvider>
			</I18nProvider>
		</MantineProvider>
	</QueryClientProvider>,
);
