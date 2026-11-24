import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Box,
	Button,
	Checkbox,
	Container,
	Divider,
	Group,
	Radio,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDebouncedValue, useDocumentTitle } from "@mantine/hooks";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { displayRole } from "@/lib/roles";
import { AccountsApiError, call } from "../api/client";
import { DemoCheckRequest, type DemoCheckT } from "../contract/contract.gen";
import { stageLabel } from "../format";
import { AccountsI18n } from "../i18n";
import { Whole } from "../ui";
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

/** The radio value for "A new organisation"; every other value is an organisation's id. */
const NEW_ORGANISATION = "new";

/** An address the check route takes, by the contract's own rule; half typed is not one. */
const checkableEmail = (value: string): string | null => {
	const email = value.trim().toLowerCase();
	return email && DemoCheckRequest.safeParse({ contact_email: email }).success
		? email
		: null;
};

/**
 * What the form knows about the contact, once their address is complete: whether they
 * have an account, the organisations the demo could go to, and earlier demos or
 * organisations under the same name. The answer stands only for the address it was asked
 * about, so changing the address hides it at once and resets the choice. Nothing is drawn
 * while the check runs; a new organisation name re-asks with the previous answer kept on
 * screen, so the section never closes and reopens.
 */
function useDemoCheck(email: string, organisationName: string) {
	const [debouncedEmail] = useDebouncedValue(email, 400);
	const [debouncedName] = useDebouncedValue(organisationName.trim(), 400);
	const asked = checkableEmail(debouncedEmail);
	const typed = checkableEmail(email);
	const check = useQuery({
		enabled: asked !== null,
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[3] === asked ? previous : undefined,
		queryFn: () =>
			call("checkDemo", {
				body: {
					contact_email: asked,
					organisation_name: debouncedName || undefined,
				},
			}),
		queryKey: ["accounts", "staff", "demo-check", asked, debouncedName],
		retry: false,
		staleTime: 60_000,
	});
	const current = asked !== null && typed === asked;
	return {
		answer: current ? check.data : undefined,
		email: asked,
		failed: current && check.isError && !check.data,
	};
}

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
	const [signIn, setSignIn] = useState(false);
	const [withOffer, setWithOffer] = useState(false);
	const [template, setTemplate] = useState<"subscription" | "event">(
		"subscription",
	);
	const [offerLanguage, setOfferLanguage] = useState<"nl" | "en">("nl");
	const [lines, setLines] = useState<Line[]>([emptyLine()]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<AccountsApiError | Error | null>(null);
	const fields = error instanceof AccountsApiError ? error.fields : {};

	const check = useDemoCheck(form.contact_email, form.organisation_name);
	const contact = check.answer?.contact ?? null;
	const organisations = contact?.organisations ?? [];
	// The choice belongs to the address it was made for; a new address starts from the
	// first of its organisations again.
	const [picked, setPicked] = useState<{ email: string; value: string } | null>(
		null,
	);
	const destination =
		picked &&
		picked.email === check.email &&
		(picked.value === NEW_ORGANISATION ||
			organisations.some((o) => o.id === picked.value))
			? picked.value
			: (organisations[0]?.id ?? NEW_ORGANISATION);
	const existing = organisations.find((o) => o.id === destination) ?? null;
	const subject = form.organisation_name.trim();

	const contactLine = check.failed
		? t`Could not check this address. The demo gets a new organisation.`
		: contact && !contact.has_account
			? t`New to dembrane. The demo gets a new organisation.`
			: contact && organisations.length === 0
				? t`They have an account but no organisation yet. The demo gets a new organisation.`
				: undefined;

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

	const signInSwitch = existing ? (
		<Switch
			checked={signIn}
			onChange={(e) => setSignIn(e.currentTarget.checked)}
			label={t`Email them when you publish`}
			description={t`Publishing adds them to the demo's workspace and emails them the link. Off: no email goes out and they are not added.`}
			data-testid="demo-sign-in"
		/>
	) : (
		<Switch
			checked={signIn}
			onChange={(e) => setSignIn(e.currentTarget.checked)}
			label={t`Let them sign in with an email code`}
			description={t`Publishing sends them the sign-in invitation. Off: no email goes out.`}
			data-testid="demo-sign-in"
		/>
	);

	const submit = async () => {
		setPending(true);
		setError(null);
		try {
			const demo = await call("createDemo", {
				body: {
					...form,
					language,
					...(existing ? { org_id: existing.id } : {}),
					offer:
						withOffer && !existing
							? {
									items: toItems(lines),
									language: offerLanguage,
									person_name: form.contact_name,
									template,
								}
							: null,
					sign_in: signIn,
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
					<Title order={3}>
						<Trans>New demo</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							We build a synthetic demo from their website and your brief.
							Nothing reaches them until you publish.
						</Trans>
					</Text>
				</Stack>

				<Stack gap="md">
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
						{input("organisation_name", t`Organisation name`, {
							required: true,
						})}
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
						<Text size="sm">
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
				</Stack>

				<Stack gap="md">
					<Divider label={t`Contact`} labelPosition="left" />
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
						{input("contact_name", t`Contact name`, { required: true })}
						{input("contact_email", t`Contact email`, {
							description: contactLine,
							inputWrapperOrder: ["label", "input", "description", "error"],
							required: true,
							type: "email",
						})}
					</SimpleGrid>
					{check.answer && <Repeats check={check.answer} />}
					{organisations.length === 0 && signInSwitch}
				</Stack>

				{organisations.length > 0 && (
					<Stack gap="md">
						<Divider label={t`Where the demo goes`} labelPosition="left" />
						<Radio.Group
							value={destination}
							onChange={(value) =>
								check.email && setPicked({ email: check.email, value })
							}
							description={
								subject
									? t`In one of their organisations, the demo gets its own workspace, ${subject}.`
									: t`In one of their organisations, the demo gets its own workspace.`
							}
							error={fields.org_id}
							data-testid="demo-destination"
						>
							<Stack gap="md">
								{organisations.map((o) => (
									<Radio
										key={o.id}
										value={o.id}
										label={o.name}
										description={
											<Terms
												terms={[
													displayRole(o.role),
													o.account_stage ? stageLabel(o.account_stage) : null,
												]}
											/>
										}
									/>
								))}
								<Radio
									value={NEW_ORGANISATION}
									label={t`A new organisation`}
									description={
										<NewOrganisationLine
											subject={subject}
											address={check.email}
										/>
									}
								/>
							</Stack>
						</Radio.Group>
						{signInSwitch}
					</Stack>
				)}

				{!existing && (
					<Stack gap="md">
						<Divider label={t`Offer`} labelPosition="left" />
						<Checkbox
							checked={withOffer}
							onChange={(e) => setWithOffer(e.currentTarget.checked)}
							label={t`Prepare an offer`}
							description={t`A draft on their account, for you to send after the demo.`}
							data-testid="demo-with-offer"
						/>
						{withOffer && (
							<Box>
								<Stack gap="sm">
									<Group gap="lg">
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
												]}
											/>
										</Stack>
										<Stack gap={4}>
											<Text size="sm">
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
									<LinesEditor
										lines={lines}
										onChange={setLines}
										errors={fields}
									/>
								</Stack>
							</Box>
						)}
					</Stack>
				)}

				{error && !Object.keys(fields).length && <ErrorNotice error={error} />}
				<Group>
					<Button
						size="md"
						onClick={submit}
						loading={pending}
						disabled={
							!form.organisation_name.trim() ||
							!form.website_url.trim() ||
							!form.brief.trim() ||
							!form.contact_name.trim() ||
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

/** What "A new organisation" makes, with the name staff typed when there is one. */
function NewOrganisationLine({
	subject,
	address,
}: {
	subject: string;
	address: string | null;
}) {
	const email = <Whole>{address ?? ""}</Whole>;
	return subject ? (
		<Trans>
			{subject} becomes a prospect in Accounts, with {email} as its admin.
		</Trans>
	) : (
		<Trans>It becomes a prospect in Accounts, with {email} as its admin.</Trans>
	);
}

/**
 * Short labels in one line of context, apart by a middle dot. Each keeps its words
 * together, so on a phone the line breaks between labels, never inside one.
 */
const Terms = ({ terms }: { terms: (string | null)[] }) =>
	terms
		.filter((term): term is string => Boolean(term))
		.map((term, i) => (
			<Fragment key={term}>
				{i > 0 && " · "}
				<Whole>{term}</Whole>
			</Fragment>
		));

/**
 * Earlier demos for this contact or this name, and organisations already called that: a
 * notice to look before building, never a stop. Each is a sentence with a link to it.
 */
function Repeats({ check }: { check: DemoCheckT }) {
	if (!check.demos.length && !check.organisations_named.length) return null;
	return (
		<Alert color="gray" data-testid="demo-repeats">
			<Stack gap="xs">
				{check.demos.map((d) => {
					const email = <Whole>{d.contact_email}</Whole>;
					const name = d.organisation_name;
					return (
						<Text key={d.id} size="sm">
							{d.same_contact ? (
								<Trans>
									There is already a demo for {email}: {name}.
								</Trans>
							) : (
								<Trans>
									There is already a demo about {name}, for {email}.
								</Trans>
							)}{" "}
							<Anchor
								component={I18nLink}
								to={`/admin/accounts/demos/${d.id}`}
								inherit
							>
								<Trans>Open it</Trans>
							</Anchor>
						</Text>
					);
				})}
				{check.organisations_named.map(({ id, name }) => (
					<Text key={id} size="sm">
						<Trans>An organisation named {name} already exists.</Trans>{" "}
						<Anchor component={I18nLink} to={`/admin/accounts/${id}`} inherit>
							<Trans>Open the account</Trans>
						</Anchor>
					</Text>
				))}
			</Stack>
		</Alert>
	);
}
