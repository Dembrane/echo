import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Modal,
	Radio,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";
import type { TaskT } from "../contract/contract.gen";
import { FitLabel, fitting } from "../FitLabel";
import { taskText } from "../format";

type Step = "offer" | "dpa" | "dpia" | "done";
const ORDER: Step[] = ["offer", "dpa", "dpia"];

interface Person {
	email: string;
	name: string;
	job: string;
}
const nobody: Person = { email: "", job: "", name: "" };

// Enough to catch a slip; the server has the final word.
const looksLikeEmail = (v: string) =>
	/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/** The first thing missing about a person, or null when they are complete. */
const missing = (p: Person): "email" | "name" | null =>
	!looksLikeEmail(p.email) ? "email" : !p.name.trim() ? "name" : null;

const asSigner = (p: Person) => ({
	email: p.email.trim(),
	name: p.name.trim(),
	role: p.job.trim() || null,
});

/**
 * The first task on a new offer: who signs the offer, who signs the data processing
 * agreement sent with it, and whether the customer needs a DPIA of their own. One question
 * per step. The answers say whose each signing task is: anyone named gets an email with a
 * link to sign. Answers are final here; a change goes
 * through a question to dembrane. Back on the left and the step's action on the right, on
 * one row.
 */
export function WhoSigns({
	orgId,
	task,
	onClose,
}: {
	orgId: string;
	task: TaskT | null;
	onClose: () => void;
}) {
	const [step, setStep] = useState<Step>("offer");
	const [offerWho, setOfferWho] = useState<"me" | "other" | null>(null);
	const [offerPerson, setOfferPerson] = useState<Person>(nobody);
	const [dpaWho, setDpaWho] = useState<"same" | "me" | "other" | null>(null);
	const [dpaPerson, setDpaPerson] = useState<Person>(nobody);
	const [dpia, setDpia] = useState<"no" | "yes" | null>(null);
	const [tried, setTried] = useState(false);
	const mutation = useAccountsMutation("answerWhoSigns", {
		orgId,
		taskId: task?.id ?? "",
	});
	const opened = task !== null;

	// Each opening starts over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only
	useEffect(() => {
		if (!opened) return;
		setStep("offer");
		setOfferWho(null);
		setOfferPerson(nobody);
		setDpaWho(null);
		setDpaPerson(nobody);
		setDpia(null);
		setTried(false);
		mutation.reset();
	}, [opened]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new step starts untried
	useEffect(() => setTried(false), [step]);

	const serverError = (key: string) =>
		mutation.error instanceof AccountsApiError
			? mutation.error.fields[key]
			: undefined;
	const fieldError =
		mutation.error instanceof AccountsApiError &&
		Object.keys(mutation.error.fields).length > 0;

	// "I do" for the DPA only makes sense when someone else signs the offer.
	const dpaOptions =
		offerWho === "other"
			? (["same", "me", "other"] as const)
			: (["same", "other"] as const);

	/** What the step still needs, worded as the primary button; null when complete. */
	const need = ((): string | null => {
		if (step === "offer") {
			if (!offerWho) return t`Choose who signs`;
			if (offerWho === "other") {
				const gap = missing(offerPerson);
				if (gap === "email") return t`Fill in their email`;
				if (gap === "name") return t`Fill in their name`;
			}
			return null;
		}
		if (step === "dpa") {
			if (!dpaWho) return t`Choose who signs`;
			if (dpaWho === "other") {
				const gap = missing(dpaPerson);
				if (gap === "email") return t`Fill in their email`;
				if (gap === "name") return t`Fill in their name`;
			}
			return null;
		}
		if (step === "dpia" && !dpia) return t`Choose an answer`;
		return null;
	})();

	const back = () => {
		const i = ORDER.indexOf(step);
		if (i <= 0) onClose();
		else setStep(ORDER[i - 1] as Step);
	};

	const next = (e?: FormEvent) => {
		e?.preventDefault();
		if (need) {
			setTried(true);
			return;
		}
		if (step === "offer") return setStep("dpa");
		if (step === "dpa") return setStep("dpia");
		mutation.mutate(
			{
				body: {
					dpa_same: dpaWho === "same",
					dpa_signer: dpaWho === "other" ? asSigner(dpaPerson) : null,
					dpia: dpia === "yes",
					offer_signer: offerWho === "other" ? asSigner(offerPerson) : null,
				},
			},
			{
				onError: (err) => {
					// A person the server refused goes back to the step that names them.
					const keys = Object.keys(
						err instanceof AccountsApiError ? err.fields : {},
					);
					if (keys.some((k) => k.startsWith("offer_signer"))) setStep("offer");
					else if (keys.some((k) => k.startsWith("dpa_signer"))) setStep("dpa");
				},
				onSuccess: () => setStep("done"),
			},
		);
	};

	const title = task ? taskText(task).title : "";
	const count = ORDER.indexOf(step) + 1;
	const offerOther = offerWho === "other" ? asSigner(offerPerson) : null;
	const dpaOther = dpaWho === "other" ? asSigner(dpaPerson) : null;
	// Whoever signs the offer also signs the DPA unless they said otherwise.
	const bothToOther = offerOther !== null && dpaWho === "same";
	const offerName = offerOther?.name ?? "";
	const offerEmail = offerOther?.email ?? "";
	const dpaName = dpaOther?.name ?? "";
	const dpaEmail = dpaOther?.email ?? "";

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			centered
			title={step === "done" ? <Trans>Thank you</Trans> : title}
			data-testid="who-signs"
		>
			{step === "done" ? (
				<Stack gap="md" data-testid="who-signs-done">
					<Group gap="sm" wrap="nowrap" align="flex-start">
						<CheckCircleIcon
							size={20}
							color="var(--app-success)"
							weight="light"
							aria-hidden
							style={{ flexShrink: 0 }}
						/>
						<Stack gap="xs">
							{offerOther &&
								(bothToOther ? (
									<Text>
										<Trans>
											We emailed {offerName} at {offerEmail} a link to sign the
											offer and the data processing agreement.
										</Trans>
									</Text>
								) : (
									<Text>
										<Trans>
											We emailed {offerName} at {offerEmail} a link to sign the
											offer.
										</Trans>
									</Text>
								))}
							{dpaOther && (
								<Text>
									<Trans>
										We emailed {dpaName} at {dpaEmail} a link to sign the data
										processing agreement.
									</Trans>
								</Text>
							)}
							{!offerOther && (
								<Text>
									<Trans>You can review and sign the offer now.</Trans>
								</Text>
							)}
							{dpia === "yes" && (
								<Text>
									<Trans>We will get in touch about your DPIA.</Trans>
								</Text>
							)}
						</Stack>
					</Group>
					<ActionRow>
						{offerOther ? (
							<span />
						) : (
							<Button onClick={onClose}>
								<Trans>Close</Trans>
							</Button>
						)}
						{offerOther || !task?.document_id ? (
							<Button
								variant="filled"
								onClick={onClose}
								data-testid="who-signs-close"
							>
								<Trans>Done</Trans>
							</Button>
						) : (
							<Button
								variant="filled"
								component={I18nLink}
								to={`/o/${orgId}/account/documents/${task.document_id}/sign`}
								data-testid="who-signs-sign"
							>
								<Trans>Review and sign</Trans>
							</Button>
						)}
					</ActionRow>
				</Stack>
			) : (
				<form onSubmit={next} noValidate>
					<Stack gap="md">
						<Text size="sm" c="dimmed">
							<Trans>Step {count} of 3</Trans>
						</Text>
						{step === "offer" && (
							<>
								<Radio.Group
									value={offerWho}
									onChange={(v) => {
										setOfferWho(v as "me" | "other");
										setTried(false);
									}}
									label={t`Who signs the offer?`}
									error={tried && !offerWho ? t`Choose one.` : undefined}
								>
									<Stack gap="xs" mt="xs">
										<Radio value="me" label={t`I do`} data-testid="offer-me" />
										<Radio
											value="other"
											label={t`Someone else`}
											data-testid="offer-other"
										/>
									</Stack>
								</Radio.Group>
								{offerWho === "other" && (
									<PersonFields
										prefix="offer"
										person={offerPerson}
										onChange={setOfferPerson}
										tried={tried}
										serverError={(k) => serverError(`offer_signer.${k}`)}
									/>
								)}
							</>
						)}
						{step === "dpa" && (
							<>
								<Radio.Group
									value={dpaWho}
									onChange={(v) => {
										setDpaWho(v as "same" | "me" | "other");
										setTried(false);
									}}
									label={t`Who signs the data processing agreement?`}
									description={t`It is a separate document. Some organisations have it signed by someone else, such as their data protection officer.`}
									error={tried && !dpaWho ? t`Choose one.` : undefined}
								>
									<Stack gap="xs" mt="xs">
										{dpaOptions.map((o) => (
											<Radio
												key={o}
												value={o}
												data-testid={`dpa-${o}`}
												label={
													o === "same"
														? t`The same person who signs the offer`
														: o === "me"
															? t`I do`
															: t`Someone else`
												}
											/>
										))}
									</Stack>
								</Radio.Group>
								{dpaWho === "other" && (
									<PersonFields
										prefix="dpa"
										person={dpaPerson}
										onChange={setDpaPerson}
										tried={tried}
										serverError={(k) => serverError(`dpa_signer.${k}`)}
									/>
								)}
							</>
						)}
						{step === "dpia" && (
							<>
								<Radio.Group
									value={dpia}
									onChange={(v) => setDpia(v as "no" | "yes")}
									label={t`Do you need your own data protection impact assessment (DPIA)?`}
									description={t`If you do, we get in touch to work on it with you.`}
									error={tried && !dpia ? t`Choose one.` : undefined}
								>
									<Stack gap="xs" mt="xs">
										<Radio value="no" label={t`No`} data-testid="dpia-no" />
										<Radio value="yes" label={t`Yes`} data-testid="dpia-yes" />
									</Stack>
								</Radio.Group>
								<Text size="xs" c="dimmed">
									<Trans>
										To change these answers later, ask us a question.
									</Trans>
								</Text>
							</>
						)}
						{mutation.error && !fieldError ? (
							<ErrorNotice error={mutation.error} />
						) : null}
						<ActionRow>
							<Button
								onClick={back}
								data-testid="who-signs-back"
								style={{ flexShrink: 0 }}
							>
								{step === "offer" ? <Trans>Cancel</Trans> : <Trans>Back</Trans>}
							</Button>
							<Button
								{...fitting}
								type="submit"
								variant="filled"
								loading={mutation.isPending}
								data-testid="who-signs-next"
							>
								<FitLabel>
									{need ??
										(step === "dpia" ? (
											<Trans>Confirm</Trans>
										) : (
											<Trans>Continue</Trans>
										))}
								</FitLabel>
							</Button>
						</ActionRow>
					</Stack>
				</form>
			)}
		</Modal>
	);
}

/** Back on the left and the step's action on the right; dialogs otherwise left-align. */
function ActionRow({ children }: { children: ReactNode }) {
	return (
		<Group
			justify="space-between"
			wrap="nowrap"
			style={{ justifyContent: "space-between" }}
		>
			{children}
		</Group>
	);
}

/** The person who signs: email first, as that is what people have at hand. */
function PersonFields({
	prefix,
	person,
	onChange,
	tried,
	serverError,
}: {
	prefix: string;
	person: Person;
	onChange: (p: Person) => void;
	tried: boolean;
	serverError: (key: string) => string | undefined;
}) {
	const gap = missing(person);
	return (
		<Stack gap="sm">
			<TextInput
				label={t`Their email address`}
				type="email"
				autoComplete="off"
				data-autofocus
				value={person.email}
				onChange={(e) => onChange({ ...person, email: e.currentTarget.value })}
				error={
					tried && gap === "email"
						? person.email.trim()
							? t`This is not an email address.`
							: t`The email address is empty.`
						: serverError("email")
				}
				data-testid={`${prefix}-email`}
			/>
			<TextInput
				label={t`Their name`}
				autoComplete="off"
				value={person.name}
				onChange={(e) => onChange({ ...person, name: e.currentTarget.value })}
				error={
					tried && gap === "name" ? t`The name is empty.` : serverError("name")
				}
				data-testid={`${prefix}-name`}
			/>
			<TextInput
				label={t`Their job title`}
				description={t`Optional. It goes on the signature.`}
				autoComplete="off"
				value={person.job}
				onChange={(e) => onChange({ ...person, job: e.currentTarget.value })}
				error={serverError("role")}
				data-testid={`${prefix}-job`}
			/>
		</Stack>
	);
}
