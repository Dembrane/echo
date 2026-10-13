// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { CustomerEmailModal, SendOfferConfirmModal } from "./SendOfferModals";

const EMAIL = {
	body: 'Hello Noor Voorbeeld,\n\nThe offer "Licence" (OFFER-1) is ready to review and sign:\nhttps://dash.test/sign',
	subject: "Your offer from dembrane: Licence",
	to: "noor@proefstad.example",
};

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
	globalThis.ResizeObserver ??= class {
		disconnect() {}
		observe() {}
		unobserve() {}
	} as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

const wrap = (ui: React.ReactNode) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>{ui}</MantineProvider>
		</I18nProvider>,
	);

it("the confirm window names the organisation, says no email is sent, and asks once", async () => {
	const onApprove = vi.fn();
	const onCancel = vi.fn();
	wrap(
		<SendOfferConfirmModal
			opened
			orgName="Gemeente Proefstad (sample)"
			loading={false}
			onApprove={onApprove}
			onCancel={onCancel}
		/>,
	);
	expect(
		await screen.findByText("Send offer to Gemeente Proefstad (sample)"),
	).toBeTruthy();
	expect(
		screen.getByText(
			"The offer and its documents appear in Gemeente Proefstad (sample)'s dembrane space.",
		),
	).toBeTruthy();
	expect(
		screen.getByText("dembrane sends no email. You send the email yourself."),
	).toBeTruthy();
	fireEvent.click(screen.getByText("Approve and place the offer"));
	expect(onApprove).toHaveBeenCalledTimes(1);
	fireEvent.click(screen.getByText("Cancel"));
	expect(onCancel).toHaveBeenCalledTimes(1);
});

it("the email window shows the email to copy, a mail link, and what to tell sam", async () => {
	const onClose = vi.fn();
	const writeText = vi.fn(async () => {});
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	});
	wrap(
		<CustomerEmailModal
			opened
			onClose={onClose}
			email={EMAIL}
			contactName="Noor Voorbeeld"
		/>,
	);
	expect(await screen.findByText("Email for Noor Voorbeeld")).toBeTruthy();
	expect(screen.getByText(EMAIL.to)).toBeTruthy();
	expect(screen.getByText(EMAIL.subject)).toBeTruthy();

	const link = screen.getByText("Open in your mail app").closest("a");
	expect(link?.getAttribute("href")).toBe(
		`mailto:${encodeURIComponent(EMAIL.to)}?subject=${encodeURIComponent(EMAIL.subject)}&body=${encodeURIComponent(EMAIL.body.replace(/\n/g, "\r\n"))}`,
	);
	expect(
		screen.getByText(
			"When you have sent it, reply sent in the offer's thread in Slack so sam marks the offer as sent.",
		),
	).toBeTruthy();

	// One filled button: the one that copies it all.
	const filled = document.querySelectorAll('button[data-variant="filled"]');
	expect(filled).toHaveLength(1);
	fireEvent.click(screen.getByText("Copy the whole email"));
	await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
	expect(writeText).toHaveBeenCalledWith(
		`To: ${EMAIL.to}\nSubject: ${EMAIL.subject}\n\n${EMAIL.body}`,
	);

	fireEvent.click(screen.getByText("Done"));
	expect(onClose).toHaveBeenCalledTimes(1);
});

it("without a contact name the window is titled by the address", async () => {
	wrap(
		<CustomerEmailModal
			opened
			onClose={() => {}}
			email={EMAIL}
			contactName={null}
		/>,
	);
	expect(await screen.findByText(`Email for ${EMAIL.to}`)).toBeTruthy();
});
