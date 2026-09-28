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

interface Line {
	id: string;
	description: string;
	bullets: string;
	quantity: number;
	unitPrice: number;
	vatPercent: number;
}

const emptyLine = (): Line => ({
	bullets: "",
	description: "",
	id: crypto.randomUUID(),
	quantity: 1,
	unitPrice: 0,
	vatPercent: 21,
});

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

	const cents = (euros: number) => Math.round(euros * 100);
	const net = lines.reduce((a, l) => a + l.quantity * cents(l.unitPrice), 0);
	const vat = lines.reduce(
		(a, l) =>
			a + Math.round((l.quantity * cents(l.unitPrice) * l.vatPercent) / 100),
		0,
	);
	const update = (i: number, patch: Partial<Line>) =>
		setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

	const submit = () =>
		push.mutate(
			{
				body: {
					attention: template === "event" ? attention : null,
					currency: "EUR",
					items: lines.map((l) => ({
						bullets: l.bullets
							.split("\n")
							.map((b) => b.trim())
							.filter(Boolean),
						description: l.description,
						quantity: l.quantity,
						unit_price_cents: cents(l.unitPrice),
						vat_rate_bps: Math.round(l.vatPercent * 100),
					})),
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
						label={t`Greeting names`}
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
				<Stack gap="sm">
					{lines.map((line, i) => (
						<Paper
							key={line.id}
							withBorder
							p="sm"
							radius="md"
							data-testid="offer-line"
						>
							<Stack gap="xs">
								<Group align="flex-end" gap="xs" wrap="nowrap">
									<TextInput
										label={t`Description`}
										style={{ flex: 1 }}
										value={line.description}
										onChange={(e) =>
											update(i, { description: e.currentTarget.value })
										}
										error={fields[`items.${i}.description`]}
										data-testid="line-description"
									/>
									{lines.length > 1 && (
										<ActionIcon
											variant="subtle"
											color="gray"
											aria-label={t`Remove line`}
											onClick={() =>
												setLines((ls) => ls.filter((_, j) => j !== i))
											}
											mb={4}
										>
											<TrashIcon size={16} />
										</ActionIcon>
									)}
								</Group>
								<Textarea
									label={t`Bullets`}
									description={t`One per line`}
									autosize
									minRows={2}
									value={line.bullets}
									onChange={(e) =>
										update(i, { bullets: e.currentTarget.value })
									}
								/>
								<SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
									<NumberInput
										label={t`Quantity`}
										min={1}
										value={line.quantity}
										onChange={(v) => update(i, { quantity: Number(v) || 1 })}
										data-testid="line-quantity"
									/>
									<NumberInput
										label={t`Unit price (EUR)`}
										min={0}
										decimalScale={2}
										value={line.unitPrice}
										onChange={(v) => update(i, { unitPrice: Number(v) || 0 })}
										data-testid="line-price"
									/>
									<NumberInput
										label={t`VAT %`}
										min={0}
										max={100}
										value={line.vatPercent}
										onChange={(v) => update(i, { vatPercent: Number(v) || 0 })}
									/>
									<Stack gap={2} justify="flex-end">
										<Text size="xs" c="dimmed">
											<Trans>Line total</Trans>
										</Text>
										<Text size="sm">
											{formatMoney(
												line.quantity * cents(line.unitPrice),
												"EUR",
												i18n.locale,
											)}
										</Text>
									</Stack>
								</SimpleGrid>
							</Stack>
						</Paper>
					))}
					<Button
						variant="subtle"
						size="xs"
						onClick={() => setLines((ls) => [...ls, emptyLine()])}
						style={{ alignSelf: "flex-start" }}
					>
						<Trans>Add a line</Trans>
					</Button>
				</Stack>

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
