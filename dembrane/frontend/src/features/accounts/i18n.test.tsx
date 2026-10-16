// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccountsI18n, signingLocale } from "./i18n";

// Signing speaks English or Dutch; the rest of the accounts screens follow the interface.
// The language is the address's prefix, so another language moves to the English address.
const Where = () => {
	const { pathname, search } = useLocation();
	return <span data-testid="where">{pathname + search}</span>;
};

const open = (path: string, signing: boolean) => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	return render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={[path]}>
					<Routes>
						<Route
							path="/:language/o/:organisationId/sign"
							element={
								<AccountsI18n signing={signing}>
									<Where />
								</AccountsI18n>
							}
						/>
					</Routes>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
};

beforeAll(() => {
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
});

afterEach(cleanup);

describe("the language of the signing screens", () => {
	it("keeps English and Dutch and reads every other language in English", () => {
		expect(signingLocale("en-US")).toBe("en-US");
		expect(signingLocale("nl-NL")).toBe("nl-NL");
		for (const other of ["de-DE", "fr-FR", "es-ES", "it-IT", "uk-UA", "cs-CZ"])
			expect(signingLocale(other)).toBe("en-US");
	});

	it("moves a signing address in German to its English twin, keeping the invitation", async () => {
		open("/de-DE/o/org-1/sign?invite=tok", true);
		await waitFor(() =>
			expect(screen.getByTestId("where").textContent).toBe(
				"/en-US/o/org-1/sign?invite=tok",
			),
		);
	});

	it("leaves a Dutch or English address where it is", async () => {
		open("/nl-NL/o/org-1/sign", true);
		await waitFor(() =>
			expect(screen.getByTestId("where").textContent).toBe(
				"/nl-NL/o/org-1/sign",
			),
		);
		cleanup();
		open("/en-US/o/org-1/sign", true);
		await waitFor(() =>
			expect(screen.getByTestId("where").textContent).toBe(
				"/en-US/o/org-1/sign",
			),
		);
	});

	it("leaves the other accounts screens in the interface language", async () => {
		open("/de-DE/o/org-1/sign", false);
		await waitFor(() =>
			expect(screen.getByTestId("where").textContent).toBe(
				"/de-DE/o/org-1/sign",
			),
		);
	});
});
