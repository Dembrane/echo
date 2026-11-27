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
import {
	ACTORS,
	fixtureActor,
	roomInviteToken,
} from "@/features/accounts/api/fixtureRoom";
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
import { RoomJoinGate, SignGate } from "@/features/accounts/signing/SignGate";
import { SignRoute } from "@/features/accounts/signing/SignRoute";
import { AccountCardRoute } from "@/features/accounts/staff/AccountCardRoute";
import { DemoRoute } from "@/features/accounts/staff/DemoRoute";
import { DocumentRoute } from "@/features/accounts/staff/DocumentRoute";
import { NewDemoRoute } from "@/features/accounts/staff/NewDemoRoute";
import { storeLanguage } from "@/lib/language";
import { cssVariablesResolver, theme } from "@/theme";

// The customer account pages on the fixture backend (VITE_ACCOUNTS_FIXTURES=1), outside
// the signed-in shell, for screenshots. ?path= picks the route; ?as=admin|billing|
// colleague|member|invitee who is looking (fixtureRoom.ts); ?room=empty|typical|crowded|
// unfilled how full the room is; ?visit=0|1|3 the labels a colleague was given. The join
// page (a path ending in /account/join) takes the invitation's real token from
// ?join=open|accepted|closed: Noor's waiting invitation, Sam's taken up, Noor's lapsed.
// The staff demo screens are here too: /en-US/admin/accounts/new-demo, which goes on to
// /en-US/admin/accounts/demos/:demoId when the form is sent. Two drafts in an organisation
// whose publish with the email on is refused open directly by their ids in
// PUBLISH_REFUSALS (fixtureBackend.ts): one whose contact left the organisation, one
// whose organisation was deleted.
// A signing path with ?invite= opens the signer's invitation page (SignGate), signed out.
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const search = new URLSearchParams(window.location.search);
const join = search.get("join");
const tokenOf = (email: string) => {
	const p = fx.roomPage.people.find((x) => x.email === email);
	return roomInviteToken({
		access_granted_at: p?.invited_at ?? null,
		id: p?.id ?? "",
	});
};
const given =
	search.get("path") ?? "/en-US/o/5f1a2b3c-0d4e-4f60-8a71-92b3c4d5e6f7/tasks";
const path =
	join && given.endsWith("/account/join")
		? `${given}?invite=${tokenOf(
				join === "accepted"
					? "sam@example-town.example"
					: "noor@example-town.example",
			)}`
		: given;

/**
 * The fixtures are the sample council's, in Dutch. An English screenshot gets English
 * sample texts laid over them here, in memory, before the fixture backend first reads
 * them; the generated fixtures and the server's stay as they are. Whole texts are
 * swapped; a title inside a longer text is swapped where it appears.
 */
const ENGLISH: Record<string, string> = {
	"5 seats, 12 maanden (60 seat-maanden)":
		"5 seats, 12 months (60 seat-months)",
	Adres: "Address",
	"Btw-nummer": "VAT number",
	"Dat kan. Na ondertekening zetten we de facturatie op vier kwartaalfacturen; het totaal blijft gelijk.":
		"Yes. Once it is signed, we split the invoicing into four quarterly invoices; the total stays the same.",
	"Datum van ondertekening": "Date of signing",
	"dembrane changemaker, jaarlicentie": "dembrane changemaker, yearly license",
	"Einddatum 31-10-2027": "End date 31-10-2027",
	Functie: "Job title",
	"Halve dag op locatie, tot 15 deelnemers":
		"Half a day on site, up to 15 participants",
	Handtekening: "Signature",
	"Hierbij ons logo.": "Here is our logo.",
	"Inclusief voorbereiding": "Preparation included",
	"Kunnen we per kwartaal betalen?": "Can we pay quarterly?",
	"Met je handtekening geldt de DPA, en is de overeenkomst compleet.":
		"Signing puts the DPA in force, which completes the agreement.",
	"Met je handtekening is de overeenkomst compleet: wij kunnen factureren, en je voorwaarden, SLA en DPA gelden.":
		"Signing makes the agreement complete, so we can invoice and your terms, SLA and DPA are in force.",
	Naam: "Name",
	"Offerte jaarlicentie DMB-DEMO-1": "Yearly license offer DMB-DEMO-1",
	"Onbeperkt aantal uren opnames": "Unlimited hours of recordings",
	"Onze afdeling financien vraagt of de jaarlicentie ook per kwartaal gefactureerd kan worden.":
		"Our finance department asks whether the yearly license can be invoiced per quarter.",
	Organisatie: "Organisation",
	"Startdatum 01-11-2026": "Start date 01-11-2026",
	"Stuur ons jullie PO-nummer": "Send us your PO number",
	"Upload jullie logo": "Upload your logo",
	"Voor de presentatie en het rapport: een logo als SVG of PNG.":
		"For the presentation and the report: a logo as SVG or PNG.",
	"Werken jullie met inkoopordernummers? Stuur het nummer, dan zetten we het op de factuur.":
		"Do you work with purchase order numbers? Send the number and we put it on the invoice.",
	Wethouder: "Alderman",
};
const PHRASES = Object.entries(ENGLISH).filter(([nl]) => nl.includes(" "));
function inEnglish(v: unknown): unknown {
	if (typeof v === "string")
		return (
			ENGLISH[v] ?? PHRASES.reduce((out, [nl, en]) => out.split(nl).join(en), v)
		);
	if (Array.isArray(v)) {
		v.forEach((x, i) => {
			v[i] = inEnglish(x);
		});
		return v;
	}
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		// The offer is then an English one, so its PDF is drawn in English.
		for (const k of Object.keys(o))
			o[k] = k === "language" && o[k] === "nl" ? "en" : inEnglish(o[k]);
		return o;
	}
	return v;
}
if (path.split("/")[1]?.startsWith("en"))
	for (const v of Object.values(fx)) inEnglish(v);
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
} else if (!path.includes("/account/join") && !path.includes("?invite=")) {
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
					<Group
						justify="space-between"
						align="flex-start"
						gap="sm"
						className="app-stack-narrow"
					>
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
			element: path.includes("?invite=") ? (
				<SignGate />
			) : (
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
		{
			element: <NewDemoRoute />,
			path: "/:language/admin/accounts/new-demo",
		},
		{
			element: <DemoRoute />,
			path: "/:language/admin/accounts/demos/:demoId",
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
