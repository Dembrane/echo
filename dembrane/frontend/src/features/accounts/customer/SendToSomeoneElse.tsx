import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { AccountsApiError } from "../api/client";
import { useAccountsMutation } from "../api/hooks";

type Step = "email" | "name" | "job" | "sent";
const ORDER: Step[] = ["email", "name", "job"];

// Enough to catch a slip; the server has the final word.
const looksLikeEmail = (v: string) =>
	/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/**
 * Handing a document to the person who signs it, one question per step: their email
 * first, as that is what people have at hand, then their name, then their job title. The
 * last step sends and says so. One signer per document: sending again replaces the one
 * named before. Every step has its primary action on the right and Back on the left, on
 * one row.
 */
export function SendToSomeoneElse({
	orgId,
	docId,
	opened,
	onClose,
}: {
	orgId: string;
	docId: string | null;
	opened: boolean;
	onClose: () => void;
}) {
	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [job, setJob] = useState("");
	const [empty, setEmpty] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const mutation = useAccountsMutation("nameSigner", {
		docId: docId ?? "",
		orgId,
	});

	// Each opening starts over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only
	useEffect(() => {
		if (!opened) return;
		setStep("email");
		setEmail("");
		setName("");
		setJob("");
		setEmpty(false);
		mutation.reset();
	}, [opened]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: focus the new step's field
	useEffect(() => {
		setEmpty(false);
		requestAnimationFrame(() => input.current?.focus());
	}, [step]);

	const serverError = (key: string) =>
		mutation.error instanceof AccountsApiError
			? mutation.error.fields[key]
			: undefined;

	const fieldError =
		mutation.error instanceof AccountsApiError &&
		Object.keys(mutation.error.fields).length > 0;

	const back = () => {
		const i = ORDER.indexOf(step);
		if (i <= 0) onClose();
		else setStep(ORDER[i - 1] as Step);
	};

	const next = (e?: FormEvent) => {
		e?.preventDefault();
		if (step === "email") {
			if (!looksLikeEmail(email)) return setEmpty(true);
			return setStep("name");
		}
		if (step === "name") {
			if (!name.trim()) return setEmpty(true);
			return setStep("job");
		}
		if (step === "job")
			mutation.mutate(
				{
					body: {
						email: email.trim(),
						name: name.trim(),
						role: job.trim() || null,
					},
				},
				{
					onError: (err) => {
						// A field the server refused goes back to its own step.
						const fields = err instanceof AccountsApiError ? err.fields : {};
						if (fields.email) setStep("email");
						else if (fields.name) setStep("name");
					},
					onSuccess: () => setStep("sent"),
				},
			);
	};

	const theirName = name.trim();
	const theirEmail = email.trim();
	const first = theirName.split(/\s+/)[0] || theirName;
	const count = ORDER.indexOf(step) + 1;

	return (
		<Modal
			opened={opened && docId !== null}
			onClose={onClose}
			centered
			title={
				step === "sent" ? (
					<Trans>Sent</Trans>
				) : (
					<Trans>Send to someone else</Trans>
				)
			}
			data-testid="send-to"
		>
			{step === "sent" ? (
				<Stack gap="md" data-testid="send-to-sent">
					<Group gap="sm" wrap="nowrap" align="flex-start">
						<CheckCircleIcon
							size={20}
							color="var(--app-success)"
							weight="light"
							aria-hidden
							style={{ flexShrink: 0 }}
						/>
						<Text>
							<Trans>
								We emailed {theirName} at {theirEmail} with a link to sign. The
								task now waits on {first}, and their signature completes it.
							</Trans>
						</Text>
					</Group>
					<Group>
						<Button
							variant="filled"
							onClick={onClose}
							data-testid="send-to-done"
						>
							<Trans>Done</Trans>
						</Button>
					</Group>
				</Stack>
			) : (
				<form onSubmit={next} noValidate>
					<Stack gap="md">
						<Text size="sm" c="dimmed">
							<Trans>Step {count} of 3</Trans>
						</Text>
						{step === "email" && (
							<TextInput
								ref={input}
								label={t`Their email address`}
								type="email"
								autoComplete="off"
								value={email}
								onChange={(e) => {
									setEmail(e.currentTarget.value);
									setEmpty(false);
								}}
								error={
									empty
										? email.trim()
											? t`This is not an email address.`
											: t`The email address is empty.`
										: serverError("email")
								}
								data-testid="send-to-email"
							/>
						)}
						{step === "name" && (
							<TextInput
								ref={input}
								label={t`Their name`}
								autoComplete="off"
								value={name}
								onChange={(e) => {
									setName(e.currentTarget.value);
									setEmpty(false);
								}}
								error={empty ? t`The name is empty.` : serverError("name")}
								data-testid="send-to-name"
							/>
						)}
						{step === "job" && (
							<TextInput
								ref={input}
								label={t`Their job title`}
								description={t`Optional. It goes on the signature.`}
								autoComplete="off"
								value={job}
								onChange={(e) => setJob(e.currentTarget.value)}
								error={serverError("role")}
								data-testid="send-to-job"
							/>
						)}
						{mutation.error && !fieldError ? (
							<ErrorNotice error={mutation.error} />
						) : null}
						{/* Back on the left and the step's action on the right, as on the signing
						    panel; dialogs otherwise put their buttons at the left. */}
						<Group
							justify="space-between"
							wrap="nowrap"
							style={{ justifyContent: "space-between" }}
						>
							<Button onClick={back} data-testid="send-to-back">
								{step === "email" ? <Trans>Cancel</Trans> : <Trans>Back</Trans>}
							</Button>
							<Button
								type="submit"
								variant="filled"
								loading={mutation.isPending}
								data-testid="send-to-next"
							>
								{step === "email" ? (
									email.trim() ? (
										<Trans>Continue</Trans>
									) : (
										<Trans>Fill in their email</Trans>
									)
								) : step === "name" ? (
									name.trim() ? (
										<Trans>Continue</Trans>
									) : (
										<Trans>Fill in their name</Trans>
									)
								) : (
									<Trans>Send</Trans>
								)}
							</Button>
						</Group>
					</Stack>
				</form>
			)}
		</Modal>
	);
}
