import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Divider,
	Group,
	Modal,
	NumberInput,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";
import type { DocumentDetailT } from "../contract/contract.gen";
import { formatMoney } from "../format";
import {
	cents,
	emptyLine,
	type Line,
	LinesEditor,
	toItems,
} from "./LinesEditor";

type Content = NonNullable<DocumentDetailT["content"]>;

const toLines = (content: Content): Line[] =>
	content.items.map((item) => ({
		bullets: item.bullets.join("\n"),
		description: item.description,
		id: crypto.randomUUID(),
		quantity: item.quantity,
		unit: item.unit ?? "",
		unitPrice: item.unit_price_cents / 100,
		vatPercent: item.vat_rate_bps / 100,
	}));

/**
 * Staff: an offer from lines, a template and a language. The backend lays it out as the
 * Google Doc templates do, pins the legal versions and places the signing fields.
 *
 * "Send offer" opens "Review and sign the offer" for the customer at once. "Save draft"
 * keeps it for staff only and leads to the page where it is read, changed and sent. With
 * `draft` the dialog changes that draft in place.
 */
export function PushOfferModal({
	opened,
	onClose,
	orgId,
	orgName,
	draft = null,
	onDraft,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	orgName: string;
	/** A draft offer to change; absent for a new offer. */
	draft?: DocumentDetailT | null;
	/** Called with the document id after a new draft is saved. */
	onDraft?: (docId: string) => void;
}) {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={draft ? t`Change the draft` : t`Push an offer`}
			size="xl"
		>
			{/* The dialog's content mounts when it opens, so each opening starts from the draft as it is. */}
			<OfferForm
				key={draft?.id ?? "new"}
				onClose={onClose}
				orgId={orgId}
				orgName={orgName}
				draft={draft}
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
	onDraft,
}: {
	onClose: () => void;
	orgId: string;
	orgName: string;
	draft: DocumentDetailT | null;
	onDraft?: (docId: string) => void;
}) {
	const { i18n } = useLingui();
	const from = draft?.content ?? null;
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
		from ? toLines(from) : [emptyLine()],
	);
	const push = useAccountsMutation("pushOffer", { orgId });
	const update = useAccountsMutation("updateOffer", { orgId });
	const error = push.error ?? update.error;
	const fields = error instanceof AccountsApiError ? error.fields : {};

	const net = lines.reduce((a, l) => a + l.quantity * cents(l.unitPrice), 0);
	const vat = lines.reduce(
		(a, l) =>
			a + Math.round((l.quantity * cents(l.unitPrice) * l.vatPercent) / 100),
		0,
	);

	const body = {
		attention: template === "event" ? attention : null,
		currency: "EUR",
		items: toItems(lines),
		language,
		offer_name: offerName,
		person_name: personName,
		template,
		// Amendments and VAT treatment come from sam; editing a draft here keeps them.
		...(template === "custom" &&
			from?.amendments && { amendments: from.amendments }),
		...(template === "subscription" &&
			from?.billing_unit && { billing_unit: from.billing_unit }),
		...(from?.vat_treatment && { vat_treatment: from.vat_treatment }),
		// Only a changed intro is sent; the draft keeps the rest of its words.
		...(intro.trim() !== firstIntro.trim() && {
			text: intro.trim() ? { intro: intro.trim() } : null,
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
				<NumberInput
					label={t`Valid for (days)`}
					min={1}
					max={365}
					value={validDays}
					onChange={(v) => setValidDays(Number(v) || 14)}
					data-testid="offer-valid-days"
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
			<LinesEditor lines={lines} onChange={setLines} errors={fields} />

			<Group justify="space-between" align="flex-end">
				<Stack gap={0}>
					<Text size="sm">
						<Trans>
							{formatMoney(net, "EUR", i18n.locale)} excl. VAT,{" "}
							{formatMoney(net + vat, "EUR", i18n.locale)} incl.
						</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							The terms, SLA and DPA versions in force today are pinned.
						</Trans>
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
