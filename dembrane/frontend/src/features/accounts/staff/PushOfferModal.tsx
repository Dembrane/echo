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
	SimpleGrid,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";
import { formatMoney } from "../format";
import {
	cents,
	emptyLine,
	type Line,
	LinesEditor,
	toItems,
} from "./LinesEditor";

/**
 * Staff: an offer from lines, a template and a language. The backend lays it out as the
 * Google Doc templates do, pins the legal versions, places the signing fields and opens
 * "Review and sign the offer" for the customer.
 */
export function PushOfferModal({
	opened,
	onClose,
	orgId,
	orgName,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	orgName: string;
}) {
	const { i18n } = useLingui();
	const [template, setTemplate] = useState<"subscription" | "event">(
		"subscription",
	);
	const [language, setLanguage] = useState<"en" | "nl">("nl");
	const [offerName, setOfferName] = useState(orgName);
	const [personName, setPersonName] = useState("");
	const [attention, setAttention] = useState("");
	const [lines, setLines] = useState<Line[]>([emptyLine()]);
	const push = useAccountsMutation("pushOffer", { orgId });
	const fields =
		push.error instanceof AccountsApiError ? push.error.fields : {};

	const net = lines.reduce((a, l) => a + l.quantity * cents(l.unitPrice), 0);
	const vat = lines.reduce(
		(a, l) =>
			a + Math.round((l.quantity * cents(l.unitPrice) * l.vatPercent) / 100),
		0,
	);

	const submit = () =>
		push.mutate(
			{
				body: {
					attention: template === "event" ? attention : null,
					currency: "EUR",
					items: toItems(lines),
					language,
					offer_name: offerName,
					person_name: personName,
					template,
				},
			},
			{
				onSuccess: () => {
					toast.success(
						t`Offer sent. The customer sees it the next time they sign in.`,
					);
					setLines([emptyLine()]);
					onClose();
				},
			},
		);

	return (
		<Modal opened={opened} onClose={onClose} title={t`Push an offer`} size="xl">
			<Stack gap="md">
				<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
					<Stack gap={4}>
						<Text size="sm" fw={500}>
							<Trans>Template</Trans>
						</Text>
						<SegmentedControl
							value={template}
							onChange={(v) => setTemplate(v as typeof template)}
							data={[
								{ label: t`Subscription`, value: "subscription" },
								{ label: t`Event`, value: "event" },
							]}
						/>
					</Stack>
					<Stack gap={4}>
						<Text size="sm" fw={500}>
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
					{template === "event" && (
						<TextInput
							label={t`For the attention of`}
							description={t`Optional`}
							value={attention}
							onChange={(e) => setAttention(e.currentTarget.value)}
						/>
					)}
				</SimpleGrid>

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
								Valid 14 days. The terms, SLA and DPA versions in force today
								are pinned.
							</Trans>
						</Text>
					</Stack>
					<Button
						onClick={submit}
						loading={push.isPending}
						data-testid="offer-submit"
					>
						<Trans>Send offer</Trans>
					</Button>
				</Group>
				{push.error && !Object.keys(fields).length && (
					<Text size="sm" c="red">
						{push.error.message}
					</Text>
				)}
			</Stack>
		</Modal>
	);
}
