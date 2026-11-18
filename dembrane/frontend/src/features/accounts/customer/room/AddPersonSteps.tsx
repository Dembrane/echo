import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Autocomplete,
	Button,
	Group,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { CheckCircleIcon } from "@phosphor-icons/react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { PersonAvatar } from "@/components/common/UserAvatar";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import type { RequestOf, ResponseOf } from "../../api/client";
import type { RoomLabelT, RoomPersonT } from "../../contract/contract.gen";
import { FitLabel, fitting } from "../../FitLabel";
import classes from "./AddPersonSteps.module.css";
import { NewSignerNotice, type Replaced, signerQuestion } from "./confirm";
import { LabelChoices, type LabelValue } from "./LabelChoices";
import {
	firstName,
	inLabelOrder,
	looksLikeEmail,
	outsideDomain,
	type RoomMe,
	type SignKind,
} from "./model";
import type { AddPreset } from "./PeopleList";
import { SigningChoice } from "./SigningChoice";
import { PersonTags } from "./Tags";

type Step = "who" | "what" | "send" | "confirm" | "sent";

/** The documents a signer can be named on now, and who signs each. */
export interface Signing {
	docs: Partial<
		Record<
			SignKind,
			{
				documentId: string;
				signer: { email: string; name: string | null } | null;
			}
		>
	>;
	/** Names the signer on one document (nameSigner); its own email goes out. */
	onName: (
		kind: SignKind,
		documentId: string,
		body: { email: string; name: string; role: string | null },
	) => Promise<unknown>;
}

const SIGN_ORDER: SignKind[] = ["offer", "dpa"];

/** A person collected without sending, for a flow that sends them itself (who signs). */
export interface DraftPerson {
	email: string;
	name: string;
	labels: RoomLabelT[];
	other: string | null;
	signs: SignKind[];
	role: string | null;
}

/**
 * Bringing someone in, one question per step: who (their address, a colleague already
 * known offered as you type, and their name), what they do (optional; and, for those who
 * may, who signs, set apart), then send. Back on the left, the step's action on the right,
 * on one row. An address outside the inviter's own domain is flagged under the field and
 * again before sending: a hint, never a block. A refusal keeps the send step and says
 * why. The last step says what happened.
 *
 * `change` is the same "what" step on its own, for someone already in: it saves.
 * `onDraft` collects the person without sending anything (who signs sends them itself).
 */
export function AddPersonSteps({
	me,
	myEmail,
	people,
	preset,
	signing,
	change = false,
	onDraft,
	onSubmit,
	onCancel,
	onDone,
	onTitle,
}: {
	me: RoomMe;
	myEmail: string;
	people: RoomPersonT[];
	preset?: AddPreset;
	/** Who signs, when there is a document to sign; shown only to those who may name. */
	signing?: Signing;
	change?: boolean;
	onDraft?: (person: DraftPerson) => void;
	onSubmit: (
		body: RequestOf<"addRoomPerson">,
	) => Promise<ResponseOf<"addRoomPerson">>;
	onCancel: () => void;
	onDone: () => void;
	/** The dialog's title for the current step, or null for the dialog's own. */
	onTitle?: (title: string | null) => void;
}) {
	const startKnown = preset?.person ?? null;
	const [step, setStep] = useState<Step>(startKnown ? "what" : "who");
	const [email, setEmail] = useState(startKnown?.email ?? "");
	const [name, setName] = useState(startKnown?.name ?? "");
	const [nameFilled, setNameFilled] = useState(false);
	const [what, setWhat] = useState<LabelValue>(() =>
		initialWhat(preset, findPerson(people, startKnown?.email ?? "")),
	);
	const [signs, setSigns] = useState<SignKind[]>(preset?.signs ?? []);
	const [job, setJob] = useState("");
	const [empty, setEmpty] = useState<"email" | "name" | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [result, setResult] = useState<{
		answer: ResponseOf<"addRoomPerson"> | null;
		signed: SignKind[];
	} | null>(null);
	const field = useRef<HTMLInputElement>(null);

	const address = email.trim().toLowerCase();
	const known = findPerson(people, address);
	const theirName = name.trim() || known?.name || "";
	const first = firstName({ email: address, name: theirName });
	const outside = outsideDomain(myEmail, address);
	const own = known?.signs ?? [];
	// The documents in `signing` are those the server lets this person name a signer on
	// (mayNameSigner); a room member never does, whatever reaches here.
	const mayName = Boolean(signing) && me.room === "by_role";
	const kinds = mayName
		? SIGN_ORDER.filter((k) => signing?.docs[k] !== undefined)
		: [];
	const newSigns = signs.filter((k) => kinds.includes(k) && !own.includes(k));
	const replaced: Replaced[] = newSigns.flatMap((kind) => {
		const now = signing?.docs[kind]?.signer;
		if (!now || now.email.toLowerCase() === address) return [];
		return [
			{
				email: now.email.toLowerCase(),
				isMe: now.email.toLowerCase() === myEmail.toLowerCase(),
				kind,
				name: now.name || now.email,
			},
		];
	});
	const holders = Object.fromEntries(
		kinds.flatMap((k) => {
			const now = signing?.docs[k]?.signer;
			if (!now || now.email.toLowerCase() === address) return [];
			const isMe = now.email.toLowerCase() === myEmail.toLowerCase();
			return [[k, isMe ? t`you` : now.name || now.email]];
		}),
	) as Partial<Record<SignKind, string>>;

	// The signer-change step is titled by its question; "Sent" by the dialog.
	// biome-ignore lint/correctness/useExhaustiveDependencies: on entering or leaving a step
	useEffect(() => {
		onTitle?.(
			step === "confirm"
				? signerQuestion(replaced)
				: step === "sent"
					? t`Sent`
					: null,
		);
		setEmpty(null);
		if (step === "who") requestAnimationFrame(() => field.current?.focus());
	}, [step]);

	const toWhat = () => {
		if (!looksLikeEmail(address)) return setEmpty("email");
		if (!theirName) return setEmpty("name");
		if (known && !preset?.labels?.length)
			setWhat({ labels: known.labels, other: known.other });
		setStep("what");
	};

	const body = (): RequestOf<"addRoomPerson"> => ({
		email: address,
		labels: inLabelOrder(what.labels),
		name: theirName,
		other: what.other?.trim() || null,
	});

	const submit = async () => {
		setPending(true);
		setError(null);
		try {
			for (const kind of newSigns) {
				const doc = signing?.docs[kind];
				if (!doc || !signing) continue;
				await signing.onName(kind, doc.documentId, {
					email: address,
					name: theirName,
					role: job.trim() || null,
				});
			}
			// Someone named to sign gets the signing link. Into the room only when the
			// person asking may invite someone new, or they are a member already (else the
			// server refuses, and the signing link is the one that counts).
			const invite =
				newSigns.length === 0 ||
				me.may_invite_new ||
				(known !== null && known.org_role !== null);
			const answer = invite ? await onSubmit(body()) : null;
			setResult({ answer, signed: newSigns });
			if (change) onDone();
			else setStep("sent");
		} catch (e) {
			setError(e);
		} finally {
			setPending(false);
		}
	};

	const next = (e?: FormEvent) => {
		e?.preventDefault();
		if (step === "who") return toWhat();
		if (step === "what") {
			if (onDraft) {
				onDraft({
					...body(),
					other: what.other?.trim() || null,
					role: job.trim() || null,
					signs: signs.filter((k) => kinds.includes(k)),
				});
				return onDone();
			}
			if (change) {
				if (replaced.length) return setStep("confirm");
				return void submit();
			}
			return setStep("send");
		}
		if (step === "send" && replaced.length) return setStep("confirm");
		void submit();
	};

	const back = () => {
		if (step === "confirm") return setStep(change ? "what" : "send");
		if (step === "send") return setStep("what");
		if (step === "what" && !change && !startKnown) return setStep("who");
		onCancel();
	};

	if (step === "sent" && result)
		return (
			<Sent
				name={theirName}
				email={address}
				answer={result.answer}
				signed={result.signed}
				onDone={onDone}
			/>
		);

	const inRoom = known !== null && known.room !== "none";
	const primary: ReactNode =
		step === "who" ? (
			<Trans>Next</Trans>
		) : step === "what" ? (
			change ? (
				<Trans>Save</Trans>
			) : onDraft ? (
				<Trans>Add</Trans>
			) : (
				<Trans>Next</Trans>
			)
		) : step === "confirm" ? (
			<Trans>Change who signs</Trans>
		) : inRoom && newSigns.length === 0 ? (
			<Trans>Save</Trans>
		) : (
			<Trans>Send</Trans>
		);
	const firstStep =
		step === "who" || (step === "what" && (change || startKnown));

	return (
		<form onSubmit={next} noValidate>
			<Stack gap="lg">
				{step === "who" && (
					<Stack gap="md">
						<Autocomplete
							ref={field}
							label={t`Their email address`}
							type="email"
							autoComplete="off"
							value={email}
							onChange={(v) => {
								setEmail(v);
								setEmpty(null);
								// A member they type the address of: their name, unless typed.
								const hit = findPerson(people, v.trim().toLowerCase());
								if (hit && (!name.trim() || nameFilled)) {
									setName(hit.name);
									setNameFilled(true);
								} else if (!hit && nameFilled) {
									setName("");
									setNameFilled(false);
								}
							}}
							// Suggestions once they type, so the list never covers the name field
							// before anything is asked of it.
							data={
								address
									? people
											.filter((p) => p.app_user_id !== me.app_user_id)
											.map((p) => ({ label: p.email, value: p.email }))
									: []
							}
							renderOption={({ option }) => {
								const p = people.find((x) => x.email === option.value);
								return p ? (
									<Group gap="sm" wrap="nowrap">
										<PersonAvatar person={p} size={28} />
										<Stack gap={0} className={classes.option}>
											<Text size="sm">{p.name}</Text>
											<Text size="xs" c="dimmed" truncate>
												{p.email}
											</Text>
										</Stack>
									</Group>
								) : (
									option.value
								);
							}}
							inputWrapperOrder={["label", "input", "description", "error"]}
							description={
								outside ? <OutsideDomain domain={outside} /> : undefined
							}
							error={
								empty === "email"
									? address
										? t`This is not an email address.`
										: t`The email address is empty.`
									: undefined
							}
							data-testid="person-email"
						/>
						<TextInput
							label={t`Their name`}
							autoComplete="off"
							maxLength={200}
							value={name}
							onChange={(e) => {
								setName(e.currentTarget.value);
								setNameFilled(false);
								setEmpty(null);
							}}
							error={empty === "name" ? t`The name is empty.` : undefined}
							data-testid="person-name"
						/>
					</Stack>
				)}
				{step === "what" && (
					<>
						<LabelChoices
							value={what}
							onChange={setWhat}
							question={t`What does ${first} do?`}
						/>
						<SigningChoice
							kinds={kinds}
							chosen={signs}
							own={own}
							holders={holders}
							onToggle={(k) =>
								setSigns((s) =>
									s.includes(k) ? s.filter((x) => x !== k) : [...s, k],
								)
							}
							job={job}
							onJob={setJob}
						/>
					</>
				)}
				{step === "send" && (
					<Stack gap="md" data-testid="person-review">
						<Group gap="sm" wrap="nowrap" align="flex-start">
							<PersonAvatar person={{ email: address, name: theirName }} />
							<Stack gap={0} className={classes.option}>
								<Text lh="24px">{theirName}</Text>
								<Text size="xs" lh="20px" c="dimmed">
									{address}
								</Text>
							</Stack>
						</Group>
						<PersonTags
							labels={what.labels}
							other={what.other}
							signs={[...own, ...newSigns]}
						/>
						<Text>{whatHappens(first, known, newSigns)}</Text>
						{outside && (
							<Text size="sm" c="dimmed">
								<OutsideDomain domain={outside} />
							</Text>
						)}
					</Stack>
				)}
				{step === "confirm" && (
					<NewSignerNotice replaced={replaced} newName={theirName} />
				)}
				{error ? <ErrorNotice error={error} /> : null}
				{/* A row of steps: Back on the left, quiet; the step's action on the right. */}
				<Group
					data-steps
					justify="space-between"
					wrap="nowrap"
					className={classes.steps}
				>
					<Button
						variant="subtle"
						onClick={back}
						data-testid="person-back"
						className={classes.back}
					>
						{firstStep ? <Trans>Cancel</Trans> : <Trans>Back</Trans>}
					</Button>
					<Button
						type="submit"
						variant="filled"
						loading={pending}
						data-testid="person-next"
						{...fitting}
					>
						<FitLabel>{primary}</FitLabel>
					</Button>
				</Group>
			</Stack>
		</form>
	);
}

const findPerson = (people: RoomPersonT[], email: string) =>
	email
		? (people.find((p) => p.email.toLowerCase() === email.toLowerCase()) ??
			null)
		: null;

function initialWhat(
	preset: AddPreset | undefined,
	known: RoomPersonT | null,
): LabelValue {
	if (preset?.labels?.length) return { labels: preset.labels, other: null };
	if (known) return { labels: known.labels, other: known.other };
	return { labels: [] as RoomLabelT[], other: null };
}

/** The hint about an address outside the inviter's own domain. */
function OutsideDomain({ domain }: { domain: string }) {
	return (
		<span data-testid="person-outside-domain">
			<Trans>
				{domain} is not your own email domain. Check that the address is right.
			</Trans>
		</span>
	);
}

/** The signing link that goes out with it, as a sentence; empty for none. */
const alsoSigns = (first: string, signs: SignKind[]): string =>
	signs.length === 2
		? t`${first} also gets a link to sign the offer and the DPA.`
		: signs[0] === "offer"
			? t`${first} also gets a link to sign the offer.`
			: signs[0] === "dpa"
				? t`${first} also gets a link to sign the DPA.`
				: "";

/** What sending does, before it is sent. */
function whatHappens(
	first: string,
	known: RoomPersonT | null,
	signs: SignKind[],
): string {
	const sign = alsoSigns(first, signs);
	const base = !known
		? t`We email ${first} a link to join your organisation. There, ${first} reads the offer and the DPA.`
		: known.room === "none"
			? t`We email ${first} a link. ${first} can then read the offer and the DPA.`
			: t`${first} is already here. Only what ${first} does changes.`;
	return sign ? `${base} ${sign}` : base;
}

/** The end of the flow: what happened, then Done. */
function Sent({
	name,
	email,
	answer,
	signed,
	onDone,
}: {
	name: string;
	email: string;
	answer: ResponseOf<"addRoomPerson"> | null;
	signed: SignKind[];
	onDone: () => void;
}) {
	const first = firstName({ email, name });
	const status = answer?.status ?? null;
	const signing = alsoSigns(first, signed);
	const base =
		status === "invited"
			? t`We emailed ${name} at ${email} a link to join. There, ${first} can read the offer and the DPA.`
			: status === "added"
				? t`We emailed ${name} at ${email}. ${first} can now read the offer and the DPA.`
				: status === "updated"
					? t`${first} was already here. What ${first} does is updated.`
					: signed.length === 2
						? t`We emailed ${name} at ${email} a link to sign the offer and the DPA.`
						: signed[0] === "dpa"
							? t`We emailed ${name} at ${email} a link to sign the DPA.`
							: t`We emailed ${name} at ${email} a link to sign the offer.`;
	const reach = status === "invited" ? (answer?.workspaces_reached ?? 0) : 0;
	return (
		<Stack gap="md" data-testid="person-sent">
			<Group gap="sm" wrap="nowrap" align="flex-start">
				<CheckCircleIcon
					size={20}
					color="var(--app-success)"
					aria-hidden
					className={classes.done}
				/>
				<Stack gap="xs">
					<Text>
						{status === null ? base : [base, signing].filter(Boolean).join(" ")}
					</Text>
					{reach > 0 && (
						<Text size="sm" c="dimmed" data-testid="person-workspaces">
							{plural(reach, {
								one: `Once ${first} joins, they are also in # workspace that every member joins.`,
								other: `Once ${first} joins, they are also in # workspaces that every member joins.`,
							})}
						</Text>
					)}
				</Stack>
			</Group>
			<Group>
				<Button variant="filled" onClick={onDone} data-testid="person-done">
					<Trans>Done</Trans>
				</Button>
			</Group>
		</Stack>
	);
}
