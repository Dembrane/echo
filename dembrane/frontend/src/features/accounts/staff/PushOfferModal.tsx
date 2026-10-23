import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Divider,
	Group,
	Modal,
	NumberInput,
	Paper,
	SegmentedControl,
	Select,
	SimpleGrid,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";
import type { DocumentDetailT } from "../contract/contract.gen";
import { formatMoney } from "../format";
import { BillToFields, billToBody, billToForm } from "./BillToFields";
import { InvoicePlanFields, planBody, planForm } from "./InvoicePlanFields";
import {
	emptyLine,
	type Line,
	LinesEditor,
	lineCents,
	toItems,
	toLines,
} from "./LinesEditor";

type VatTreatment = "standard" | "reverse_charge" | "outside_eu";

/** The currencies offered first; the API takes any ISO code, and a draft keeps its own. */
const CURRENCIES = [
	"EUR",
	"USD",
	"GBP",
	"CHF",
	"SEK",
	"NOK",
	"DKK",
	"PLN",
	"CZK",
];

/** The most amendments one offer carries (contract: PushOfferRequest.amendments). */
const MAX_AMENDMENTS = 10;

interface Amendment {
	id: string;
	title: string;
	body: string;
}

/**
 * Staff: an offer from lines, a template and a language. The backend lays it out as the
 * Google Doc templates do, pins the legal versions and places the signing fields.
 *
 * "Send offer" opens "Review and sign the offer" for the customer at once. "Save draft"
 * keeps it for staff only and leads to the page where it is read, changed and sent. With
 * `draft` the dialog changes that draft in place. With `revise` it starts from a sent
 * offer and pushes a new version under the same reference that replaces it.
 */
export function PushOfferModal({
	opened,
	onClose,
	orgId,
	orgName,
	draft = null,
	revise = null,
	onDraft,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	orgName: string;
	/** A draft offer to change; absent for a new offer. */
	draft?: DocumentDetailT | null;
	/** A sent offer to replace with a new version. */
	revise?: DocumentDetailT | null;
	/** Called with the document id after a new draft is saved, and after any revision. */
	onDraft?: (docId: string) => void;
}) {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				draft
					? t`Change the draft`
					: revise
						? t`Revise the offer`
						: t`Push an offer`
			}
			size="xl"
		>
			{/* The dialog's content mounts when it opens, so each opening starts from the draft as it is. */}
			<OfferForm
				key={draft?.id ?? revise?.id ?? "new"}
				onClose={onClose}
				orgId={orgId}
				orgName={orgName}
				draft={draft}
				revise={revise}
				onDraft={onDraft}
			/>
		</Modal>
	);
}

function OfferForm({
	onClose,
	orgId,
	orgName,
	draft,
	revise,
	onDraft,
}: {
	onClose: () => void;
	orgId: string;
	orgName: string;
	draft: DocumentDetailT | null;
	revise: DocumentDetailT | null;
	onDraft?: (docId: string) => void;
}) {
	const { i18n } = useLingui();
	const from = (draft ?? revise)?.content ?? null;
	const [template, setTemplate] = useState<"subscription" | "event" | "custom">(
		from?.template ?? "subscription",
	);
	const [language, setLanguage] = useState<"en" | "nl">(from?.language ?? "nl");
	// Empty means the template's intro; a draft shows its own.
	const firstIntro = from?.text?.intro ?? "";
	const [intro, setIntro] = useState(firstIntro);
	const [validDays, setValidDays] = useState<number>(from?.valid_days ?? 14);
	const [offerName, setOfferName] = useState(from?.offer_name ?? orgName);
	const [personName, setPersonName] = useState(from?.person_name ?? "");
	const [attention, setAttention] = useState(from?.attention ?? "");
	const [lines, setLines] = useState<Line[]>(
		from ? toLines(from.items) : [emptyLine()],
	);
	const [currency, setCurrency] = useState(from?.currency ?? "EUR");
	const [vatTreatment, setVatTreatment] = useState<VatTreatment>(
		from?.vat_treatment ?? "standard",
	);
	const [processingTerms, setProcessingTerms] = useState(
		from?.processing_terms ?? "",
	);
	const [customerReference, setCustomerReference] = useState(
		from?.customer_reference ?? "",
	);
	const [billsOther, setBillsOther] = useState(Boolean(from?.bill_to));
	const [billTo, setBillTo] = useState(() => billToForm(from?.bill_to));
	const [plan, setPlan] = useState(() =>
		planForm(from?.invoice_plan, from?.no_charge === true),
	);
	const noCharge = plan.kind === "none";
	const [amendments, setAmendments] = useState<Amendment[]>(
		(from?.amendments ?? []).map((a) => ({ ...a, id: crypto.randomUUID() })),
	);
	/** A new version keeps the sent offer's words, with the intro as it reads above. */
	const revisedText = () => {
		const same = template === from?.template && language === from?.language;
		const { intro: _intro, ...rest } = (same && from?.text) || {};
		const words = { ...rest, ...(intro.trim() && { intro: intro.trim() }) };
		return Object.keys(words).length ? words : null;
	};
	const setAmendment = (i: number, patch: Partial<Amendment>) =>
		setAmendments((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));
	// Reverse charge and outside the EU take 0% lines; the rates typed stay for a switch back.
	const vatFixed = vatTreatment !== "standard";
	const priced = vatFixed ? lines.map((l) => ({ ...l, vatPercent: 0 })) : lines;
	const push = useAccountsMutation("pushOffer", { orgId });
	const update = useAccountsMutation("updateOffer", { orgId });
	const error = push.error ?? update.error;
	const fields = error instanceof AccountsApiError ? error.fields : {};

	const net = priced.reduce((a, l) => a + lineCents(l), 0);
	const vat = priced.reduce(
		(a, l) => a + Math.round((lineCents(l) * l.vatPercent) / 100),
		0,
	);

	const introChanged = intro.trim() !== firstIntro.trim();
	const body = {
		// Shown for event offers only; any other keeps what the draft had.
		attention: template === "event" ? attention : (from?.attention ?? null),
		bill_to: noCharge ? null : billToBody(billsOther, billTo),
		currency,
		customer_reference: customerReference.trim() || null,
		invoice_plan: planBody(plan),
		items: toItems(priced),
		language,
		no_charge: noCharge,
		offer_name: offerName,
		person_name: personName,
		processing_terms: processingTerms.trim() || null,
		template,
		vat_treatment: vatTreatment,
		...(template === "custom" && {
			amendments: amendments.map((a) => ({
				body: a.body.trim(),
				title: a.title.trim(),
			})),
		}),
		...(template === "subscription" &&
			from?.billing_unit && { billing_unit: from.billing_unit }),
		// Only a changed intro is sent; the draft keeps the rest of its words.
		...(!revise &&
			introChanged && {
				text: intro.trim() ? { intro: intro.trim() } : null,
			}),
		...(revise && {
			reference: revise.reference,
			supersedes_id: revise.id,
			text: revisedText(),
		}),
		valid_days: validDays,
	};

	const submit = (send: boolean) => {
		if (draft) {
			update.mutate(
				{ body, params: { docId: draft.id } },
				{
					onSuccess: () => {
						toast.success(t`Draft saved`);
						onClose();
					},
				},
			);
			return;
		}
		push.mutate(
			{ body: { ...body, send } },
			{
				onSuccess: (res) => {
					toast.success(
						send
							? t`Offer sent. The customer sees it the next time they log in.`
							: t`Draft saved`,
					);
					setLines([emptyLine()]);
					// A revision leads to the new version, whose page has no dialog open.
					if (revise && onDraft) return onDraft(res.document.id);
					onClose();
					if (!send) onDraft?.(res.document.id);
				},
			},
		);
	};
	// Which of the two buttons is working, so only that one spins.
	const sending = push.isPending && push.variables?.body?.send !== false;
	const saving = update.isPending || (push.isPending && !sending);

	return (
		<Stack gap="md">
			<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
				<Stack gap={4}>
					<Text size="sm">
						<Trans>Template</Trans>
					</Text>
					<SegmentedControl
						value={template}
						onChange={(v) => setTemplate(v as typeof template)}
						data={[
							{ label: t`Subscription`, value: "subscription" },
							{ label: t`Event`, value: "event" },
							{ label: t`Custom`, value: "custom" },
						]}
					/>
				</Stack>
				<Stack gap={4}>
					<Text size="sm">
						<Trans>Language</Trans>
					</Text>
					<SegmentedControl
						value={language}
						onChange={(v) => setLanguage(v as typeof language)}
						data={[
							{ label: "Nederlands", value: "nl" },
							{ label: "English", value: "en" },
						]}
					/>
				</Stack>
				<TextInput
					label={t`Customer name in the title`}
					description={t`Reads "${offerName || "..."} x dembrane"`}
					value={offerName}
					onChange={(e) => setOfferName(e.currentTarget.value)}
					error={fields.offer_name}
					data-testid="offer-name"
				/>
				<TextInput
					label={t`Name in the greeting`}
					description={t`Optional`}
					value={personName}
					onChange={(e) => setPersonName(e.currentTarget.value)}
					data-testid="offer-person"
				/>
				<Stack gap={4}>
					<Text size="sm">
						<Trans>VAT</Trans>
					</Text>
					<SegmentedControl
						value={vatTreatment}
						onChange={(v) => setVatTreatment(v as VatTreatment)}
						data={[
							{ label: t`Dutch VAT`, value: "standard" },
							{ label: t`Reverse charge`, value: "reverse_charge" },
							{ label: t`Outside the EU`, value: "outside_eu" },
						]}
						data-testid="offer-vat-treatment"
					/>
				</Stack>
				<Select
					label={t`Currency`}
					value={currency}
					onChange={(v) => v && setCurrency(v)}
					data={
						CURRENCIES.includes(currency)
							? CURRENCIES
							: [currency, ...CURRENCIES]
					}
					allowDeselect={false}
					searchable
					data-testid="offer-currency"
				/>
				<NumberInput
					label={t`Valid for (days)`}
					min={1}
					max={365}
					value={validDays}
					onChange={(v) => setValidDays(Number(v) || 14)}
					data-testid="offer-valid-days"
				/>
				<TextInput
					label={t`Customer reference`}
					description={t`PO, order or project number`}
					value={customerReference}
					onChange={(e) => setCustomerReference(e.currentTarget.value)}
					error={fields.customer_reference}
					maxLength={64}
					data-testid="offer-customer-reference"
				/>
				{template === "event" && (
					<TextInput
						label={t`For the attention of`}
						description={t`Optional`}
						value={attention}
						onChange={(e) => setAttention(e.currentTarget.value)}
					/>
				)}
			</SimpleGrid>

			<Textarea
				label={t`Intro`}
				description={t`Empty: the template's. A blank line starts a paragraph.`}
				autosize
				minRows={2}
				value={intro}
				onChange={(e) => setIntro(e.currentTarget.value)}
				error={fields["text.intro"]}
				data-testid="offer-intro"
			/>

			<Divider label={t`Lines`} labelPosition="left" />
			<LinesEditor
				lines={lines}
				onChange={setLines}
				errors={fields}
				currency={currency}
				discounts
				sections
				vatFixed={vatFixed}
			/>

			<Divider label={t`Invoicing`} labelPosition="left" />
			<InvoicePlanFields
				value={plan}
				onChange={setPlan}
				net={net}
				currency={currency}
				errors={fields}
			/>
			{!noCharge && (
				<BillToFields
					on={billsOther}
					onToggle={setBillsOther}
					value={billTo}
					onChange={setBillTo}
					errors={fields}
				/>
			)}

			<Divider label={t`Terms`} labelPosition="left" />
			<TextInput
				label={t`Their data processing terms`}
				description={t`Optional, replaces our DPA`}
				value={processingTerms}
				onChange={(e) => setProcessingTerms(e.currentTarget.value)}
				error={fields.processing_terms}
				maxLength={500}
				data-testid="offer-processing-terms"
			/>
			{template === "custom" && (
				<Stack gap="xs" data-testid="offer-amendments">
					<Stack gap={0}>
						<Text size="sm">
							<Trans>Changes to our terms</Trans>
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>These win over our standard terms</Trans>
						</Text>
					</Stack>
					{amendments.map((a, i) => (
						<Paper
							key={a.id}
							withBorder
							p="sm"
							radius="md"
							data-testid="offer-amendment"
						>
							<Stack gap="xs">
								<Group align="flex-end" gap="xs" wrap="nowrap">
									<TextInput
										label={t`What it changes`}
										placeholder={t`Liability cap`}
										style={{ flex: 1 }}
										value={a.title}
										maxLength={120}
										onChange={(e) =>
											setAmendment(i, { title: e.currentTarget.value })
										}
										error={fields[`amendments.${i}.title`]}
										data-testid="amendment-title"
									/>
									<ActionIcon
										variant="subtle"
										color="gray"
										aria-label={t`Remove change`}
										onClick={() =>
											setAmendments((as) => as.filter((_, j) => j !== i))
										}
										mb={4}
									>
										<TrashIcon size={16} />
									</ActionIcon>
								</Group>
								<Textarea
									label={t`The term`}
									autosize
									minRows={2}
									value={a.body}
									maxLength={4000}
									onChange={(e) =>
										setAmendment(i, { body: e.currentTarget.value })
									}
									error={fields[`amendments.${i}.body`]}
									data-testid="amendment-body"
								/>
							</Stack>
						</Paper>
					))}
					{amendments.length < MAX_AMENDMENTS && (
						<Button
							variant="subtle"
							size="xs"
							style={{ alignSelf: "flex-start" }}
							onClick={() =>
								setAmendments((as) => [
									...as,
									{ body: "", id: crypto.randomUUID(), title: "" },
								])
							}
							data-testid="add-amendment"
						>
							<Trans>Add a change</Trans>
						</Button>
					)}
				</Stack>
			)}

			<Group justify="space-between" align="flex-end">
				<Stack gap={0}>
					<Text size="sm">
						<Trans>
							{formatMoney(net, currency, i18n.locale)} excl. VAT,{" "}
							{formatMoney(net + vat, currency, i18n.locale)} incl.
						</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						{revise ? (
							<Trans>Sending replaces the sent version.</Trans>
						) : (
							<Trans>
								The terms, SLA and DPA versions in force today are pinned.
							</Trans>
						)}
					</Text>
				</Stack>
				<Group gap="xs">
					{/* Quiet beside "Send offer", so the button people know stays the obvious one. */}
					<Button
						variant={draft ? undefined : "subtle"}
						onClick={() => submit(false)}
						loading={saving}
						disabled={sending}
						data-testid="offer-save-draft"
					>
						<Trans>Save draft</Trans>
					</Button>
					{!draft && (
						<Button
							onClick={() => submit(true)}
							loading={sending}
							disabled={saving}
							data-testid="offer-submit"
						>
							<Trans>Send offer</Trans>
						</Button>
					)}
				</Group>
			</Group>
			{error && !Object.keys(fields).length && <ErrorNotice error={error} />}
		</Stack>
	);
}
