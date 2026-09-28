import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Box,
	Button,
	Checkbox,
	Container,
	Divider,
	Group,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { AccountsApiError, call } from "../api/client";
import { AccountsI18n } from "../i18n";
import { StaffOnly } from "./AccountCardRoute";
import { emptyLine, type Line, LinesEditor, toItems } from "./LinesEditor";

/**
 * Staff: a synthetic demo for a prospect. This screen only collects what the generator
 * needs; the progress, the draft and "Publish" are the next screen, so the decision to
 * send anything to the prospect is made there, with the draft in front of staff.
 */
export const NewDemoRoute = () => (
	<AccountsI18n>
		<StaffOnly>
			<NewDemo />
		</StaffOnly>
	</AccountsI18n>
);

function NewDemo() {
	useDocumentTitle(t`New demo | dembrane`);
	const navigate = useI18nNavigate();
	const [form, setForm] = useState({
		brief: "",
		contact_email: "",
		contact_name: "",
		example: "",
		organisation_name: "",
		website_url: "",
	});
	const [language, setLanguage] = useState<"nl" | "en">("nl");
	const [emailCode, setEmailCode] = useState(false);
	const [withOffer, setWithOffer] = useState(false);
	const [template, setTemplate] = useState<"subscription" | "event">(
		"subscription",
	);
	const [offerLanguage, setOfferLanguage] = useState<"nl" | "en">("nl");
	const [lines, setLines] = useState<Line[]>([emptyLine()]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<AccountsApiError | Error | null>(null);
	const fields = error instanceof AccountsApiError ? error.fields : {};

	const input = (
		key: keyof typeof form,
		label: string,
		extra: Record<string, unknown> = {},
	) => (
		<TextInput
			label={label}
			value={form[key]}
			onChange={(e) => {
				const value = e.currentTarget.value;
				setForm((f) => ({ ...f, [key]: value }));
			}}
			error={fields[key]}
			data-testid={`demo-${key}`}
			{...extra}
		/>
	);

	const submit = async () => {
		setPending(true);
		setError(null);
		try {
			const demo = await call("startDemo", {
				body: {
					...form,
					email_code_sign_in: emailCode,
					language,
					offer: withOffer
						? { items: toItems(lines), language: offerLanguage, template }
						: null,
				},
			});
			navigate(`/admin/accounts/demos/${demo.id}`);
		} catch (e) {
			setError(e instanceof Error ? e : new Error(String(e)));
		} finally {
			setPending(false);
		}
	};

	return (
		<Container size="md" px={{ base: "md", sm: "lg" }} py="xl">
			<Stack gap="lg" data-testid="new-demo-form">
				<Stack gap={4}>
					<Anchor
						component={I18nLink}
						to="/admin/accounts"
						size="sm"
						c="dimmed"
					>
						<Group gap={4}>
							<ArrowLeftIcon size={14} />
							<Trans>Accounts</Trans>
						</Group>
					</Anchor>
					<Title order={3} fw={400}>
						<Trans>New demo</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							We build a synthetic demo from their website and your brief.
							Nothing reaches them until you publish.
						</Trans>
					</Text>
				</Stack>

				<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
					{input("organisation_name", t`Organisation name`, { required: true })}
					{input("website_url", t`Website`, {
						placeholder: "https://",
						required: true,
						type: "url",
					})}
				</SimpleGrid>
				<Textarea
					label={t`Brief`}
					description={t`What they want to hear from whom, and why now.`}
					autosize
					minRows={3}
					required
					value={form.brief}
					onChange={(e) => {
						const value = e.currentTarget.value;
						setForm((f) => ({ ...f, brief: value }));
					}}
					error={fields.brief}
					data-testid="demo-brief"
				/>
				<Textarea
					label={t`Event or customer example`}
					description={t`Optional. A past event or customer to model the demo on.`}
					autosize
					minRows={2}
					value={form.example}
					onChange={(e) => {
						const value = e.currentTarget.value;
						setForm((f) => ({ ...f, example: value }));
					}}
				/>
				<Stack gap={4}>
					<Text size="sm" fw={500}>
						<Trans>Demo language</Trans>
					</Text>
					<SegmentedControl
						value={language}
						onChange={(v) => setLanguage(v as typeof language)}
						data={[
							{ label: "Nederlands", value: "nl" },
							{ label: "English", value: "en" },
						]}
						w={260}
					/>
				</Stack>

				<Divider label={t`Contact`} labelPosition="left" />
				<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
					{input("contact_name", t`Contact name`)}
					{input("contact_email", t`Contact email`, {
						required: true,
						type: "email",
					})}
				</SimpleGrid>
				<Switch
					checked={emailCode}
					onChange={(e) => setEmailCode(e.currentTarget.checked)}
					label={t`Let them sign in with an email code`}
					description={t`Publishing sends them the sign-in invitation. Off: no email goes out.`}
					data-testid="demo-email-code"
				/>

				<Divider label={t`Offer`} labelPosition="left" />
				<Checkbox
					checked={withOffer}
					onChange={(e) => setWithOffer(e.currentTarget.checked)}
					label={t`Prepare an offer`}
					description={t`Sent with the demo when you publish.`}
					data-testid="demo-with-offer"
				/>
				{withOffer && (
					<Box>
						<Stack gap="sm">
							<Group gap="lg">
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
										<Trans>Offer language</Trans>
									</Text>
									<SegmentedControl
										value={offerLanguage}
										onChange={(v) =>
											setOfferLanguage(v as typeof offerLanguage)
										}
										data={[
											{ label: "Nederlands", value: "nl" },
											{ label: "English", value: "en" },
										]}
									/>
								</Stack>
							</Group>
							<LinesEditor lines={lines} onChange={setLines} errors={fields} />
						</Stack>
					</Box>
				)}

				{error && !Object.keys(fields).length && (
					<Text size="sm" c="red">
						{error.message}
					</Text>
				)}
				<Group>
					<Button
						size="md"
						onClick={submit}
						loading={pending}
						disabled={
							!form.organisation_name.trim() ||
							!form.website_url.trim() ||
							!form.brief.trim() ||
							!form.contact_email.trim()
						}
						data-testid="demo-submit"
					>
						<Trans>Build the demo</Trans>
					</Button>
				</Group>
			</Stack>
		</Container>
	);
}
