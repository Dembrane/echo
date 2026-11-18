import "@mantine/core/styles.css";
import "@/index.css";
import { Group, MantineProvider, Stack, Title } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { PageContainer } from "@/components/layout/PageContainer";
import { ACTORS, fixtureActor } from "@/features/accounts/api/fixtureRoom";
import * as fx from "@/features/accounts/contract/fixtures.gen";
import {
	AccountDocumentsRoute,
	AccountOverviewContact,
	AccountOverviewCorner,
	AccountOverviewRoom,
	AccountOverviewWork,
	AccountTasksRoute,
} from "@/features/accounts/customer/AccountRoute";
import { AccountsI18n } from "@/features/accounts/i18n";
import { RoomJoinGate } from "@/features/accounts/signing/SignGate";
import { SignRoute } from "@/features/accounts/signing/SignRoute";
import { AccountCardRoute } from "@/features/accounts/staff/AccountCardRoute";
import { DocumentRoute } from "@/features/accounts/staff/DocumentRoute";
import { storeLanguage } from "@/lib/language";
import { cssVariablesResolver, theme } from "@/theme";

// The customer account pages on the fixture backend (VITE_ACCOUNTS_FIXTURES=1), outside
// the signed-in shell, for screenshots. ?path= picks the route; ?as=admin|billing|
// colleague|member who is looking (fixtureRoom.ts); ?room=empty|typical|crowded|unfilled
// how full the room is; ?visit=0|1|3 the labels a colleague was given. The join page reads
// its invitation from ?invite= in the path (`accepted…`, `closed…` for those states).
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const path =
	new URLSearchParams(window.location.search).get("path") ??
	"/en-US/o/5f1a2b3c-0d4e-4f60-8a71-92b3c4d5e6f7/tasks";
// The harness's language provider sits outside the router, so the address's language is
// stored first, as choosing it in the app would.
storeLanguage(path.split("/")[1] ?? "en-US");
// The staff card asks who is looking; the harness answers "staff".
if (path.includes("/admin/")) {
	queryClient.setQueryData(["v2", "me"], {
		display_name: "Staff",
		email: "staff@dembrane.com",
		is_staff: true,
	});
} else if (!path.includes("/account/join")) {
	queryClient.setQueryData(["v2", "me"], {
		email: ACTORS[fixtureActor()].email,
	});
}

/** The organisation overview's account parts, as OrganisationRoute lays them out. */
function Overview() {
	const { organisationId = "" } = useParams();
	return (
		<AccountsI18n>
			<PageContainer width="xl">
				<Stack gap={24}>
					<Group justify="space-between" align="flex-start" gap="sm">
						<Title order={2}>{fx.accountPage.organisation.name}</Title>
						<AccountOverviewCorner orgId={organisationId} />
					</Group>
					<Stack gap={32}>
						<AccountOverviewWork orgId={organisationId} />
						<AccountOverviewRoom orgId={organisationId} />
						<AccountOverviewContact orgId={organisationId} />
					</Stack>
				</Stack>
			</PageContainer>
		</AccountsI18n>
	);
}

const router = createMemoryRouter(
	[
		{
			element: <Overview />,
			path: "/:language/o/:organisationId/overview",
		},
		{
			element: <AccountTasksRoute />,
			path: "/:language/o/:organisationId/tasks",
		},
		{
			element: <AccountDocumentsRoute />,
			path: "/:language/o/:organisationId/documents",
		},
		{
			element: (
				<AccountsI18n signing>
					<SignRoute />
				</AccountsI18n>
			),
			path: "/:language/o/:organisationId/account/documents/:docId/sign",
		},
		{
			element: <RoomJoinGate />,
			path: "/:language/o/:organisationId/account/join",
		},
		{ element: <AccountCardRoute />, path: "/:language/admin/accounts/:orgId" },
		{
			element: <DocumentRoute />,
			path: "/:language/admin/accounts/:orgId/documents/:docId",
		},
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
