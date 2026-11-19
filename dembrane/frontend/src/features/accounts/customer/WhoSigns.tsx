import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Menu, Radio, Stack, Text } from "@mantine/core";
import { CheckCircleIcon, UserPlusIcon } from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { PersonAvatar } from "@/components/common/UserAvatar";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useV2Me } from "@/hooks/useV2Me";
import { AccountsApiError } from "../api/client";
import { useAccountPage, useAccountsMutation, useRoom } from "../api/hooks";
import type { TaskT } from "../contract/contract.gen";
import { FitLabel, fitting } from "../FitLabel";
import { taskText } from "../format";
import { Rows } from "./PageSection";
import { signable } from "./room/AddPersonModal";
import { AddPersonSteps, type DraftPerson } from "./room/AddPersonSteps";
import { signText } from "./room/copy";
import { mayNameSigner, type SignKind } from "./room/model";
import { StepsModal } from "./StepsModal";
import { KindIcon, secondary, TaskLine } from "./TaskLine";
import classes from "./WhoSigns.module.css";

type Step = "signers" | "dpia" | "done";
const ORDER: Step[] = ["signers", "dpia"];
const KINDS: SignKind[] = ["offer", "dpa"];

/** Someone who may sign: the person asking, someone in the room, or someone just added. */
interface Candidate {
	email: string;
	name: string;
	role: string | null;
	draft?: DraftPerson;
	/** A member who is not in the room yet. */
	outside?: boolean;
}

/**
 * The first task on a new offer: who signs the offer, who signs the DPA sent with it, and
 * whether the customer needs a DPIA of their own. The signers are chosen one line per
 * document: the person asking, someone already in the room, or someone new through the
 * same person flow as everywhere else (AddPersonSteps, with that signing duty chosen).
 * The DPIA is about the organisation, so it stays its own question. Anyone named gets an
 * email with a link to sign when the task is confirmed; someone new is brought into the
 * room too. Naming someone else is for owners and admins (the document's may_name_signer);
 * Billing answers that they sign. Answers are final here; a change goes through a
 * question to dembrane.
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
	const opened = task !== null;
	const [step, setStep] = useState<Step>("signers");
	const [holders, setHolders] = useState<Record<SignKind, string | null>>({
		dpa: null,
		offer: null,
	});
	const [added, setAdded] = useState<Candidate[]>([]);
	const [adding, setAdding] = useState<SignKind | null>(null);
	const [dpia, setDpia] = useState<"no" | "yes" | null>(null);
	const [tried, setTried] = useState(false);
	const [error, setError] = useState<unknown>(null);
	// The answer went through, but bringing someone new into the room did not.
	const [addError, setAddError] = useState<unknown>(null);
	const [pending, setPending] = useState(false);
	const { data: me } = useV2Me({ enabled: opened });
	const { data: room } = useRoom(orgId, opened);
	const { data: page } = useAccountPage(opened ? orgId : undefined);
	const answer = useAccountsMutation("answerWhoSigns", {
		orgId,
		taskId: task?.id ?? "",
	});
	const add = useAccountsMutation("addRoomPerson", { orgId });

	// Each opening starts over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only
	useEffect(() => {
		if (!opened) return;
		setStep("signers");
		setHolders({ dpa: null, offer: null });
		setAdded([]);
		setAdding(null);
		setDpia(null);
		setTried(false);
		setError(null);
		setAddError(null);
	}, [opened]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new step starts untried
	useEffect(() => setTried(false), [step]);

	const myEmail = (me?.email ?? "").toLowerCase();
	const myName =
		room?.people.find((p) => p.app_user_id === room.me?.app_user_id)?.name ??
		myEmail;
	const offer = page?.documents.find((d) => d.id === task?.document_id);
	const mayName = mayNameSigner(offer);
	// The DPA sent with the offer, while it waits; its signer may be named apart.
	const dpaDoc = page?.documents.find(
		(d) =>
			d.kind === "dpa" &&
			d.requires_signature &&
			(d.status === "sent" || d.status === "viewed"),
	);
	const docOf = (kind: SignKind) => (kind === "offer" ? offer : dpaDoc);
	// Who is named on each document now (staff may name the offer's signer when sending).
	const named = (kind: SignKind) => {
		const s = docOf(kind)?.signer;
		return s
			? { email: s.email.toLowerCase(), name: s.name || s.email, role: s.role }
			: null;
	};
	// Someone named is kept unless changed; only who may name a signer changes them.
	const locked = (kind: SignKind) =>
		named(kind) !== null &&
		named(kind)?.email !== myEmail &&
		!mayNameSigner(docOf(kind));
	// Everyone who may be chosen, by name; members not in the room yet are marked so.
	const candidates: Candidate[] = [
		{ email: myEmail, name: myName, role: null },
		...KINDS.flatMap((k) => {
			const n = named(k);
			return n && n.email !== myEmail ? [n] : [];
		}),
		...(mayName
			? (room?.people ?? [])
					.filter((p) => p.email.toLowerCase() !== myEmail)
					.map((p) => ({
						email: p.email.toLowerCase(),
						name: p.name,
						outside: p.room === "none",
						role: null,
					}))
			: []),
		...added.filter(
			(a) => !room?.people.some((p) => p.email.toLowerCase() === a.email),
		),
	]
		// One line per person: someone named may be in the room too.
		.filter((c, i, all) => all.findIndex((x) => x.email === c.email) === i)
		.sort((a, b) => a.name.localeCompare(b.name));
	const who = (email: string | null) =>
		candidates.find((c) => c.email === email) ?? null;

	// The question starts from what is true: whoever is named on each document now.
	const offerNamed = named("offer")?.email ?? null;
	const dpaNamed = named("dpa")?.email ?? null;
	useEffect(() => {
		if (!opened) return;
		setHolders((h) => ({
			dpa: h.dpa ?? dpaNamed,
			offer: h.offer ?? offerNamed,
		}));
	}, [opened, offerNamed, dpaNamed]);

	const choose = (kind: SignKind, email: string) =>
		setHolders((h) => ({
			...h,
			[kind]: email,
			// Whoever signs the offer signs the DPA too, unless said otherwise.
			...(kind === "offer" && !h.dpa ? { dpa: email } : {}),
		}));

	/** What the step still needs, worded as the primary button; null when complete. */
	const need = ((): string | null => {
		if (step === "signers") {
			if (!holders.offer) return t`Choose who signs the offer`;
			if (!holders.dpa) return t`Choose who signs the DPA`;
			return null;
		}
		if (step === "dpia" && !dpia) return t`Choose an answer`;
		return null;
	})();

	const confirm = async () => {
		const o = who(holders.offer);
		const d = who(holders.dpa);
		if (!o || !d) return;
		const asSigner = (c: Candidate) => ({
			email: c.email,
			name: c.name,
			role: c.role,
		});
		const dpaSame = o.email === d.email;
		setPending(true);
		setError(null);
		try {
			await answer.mutateAsync({
				body: {
					dpa_same: dpaSame,
					dpa_signer: dpaSame || d.email === myEmail ? null : asSigner(d),
					dpia: dpia === "yes",
					offer_signer: o.email === myEmail ? null : asSigner(o),
				},
			});
			// Someone new comes into the room with what they do, once named. The signing
			// link has gone out by now, so a refusal here is said on the last step.
			for (const c of added) {
				if (!c.draft || !room?.me?.may_invite_new) continue;
				const { signs: _s, role: _r, ...body } = c.draft;
				await add.mutateAsync({ body }).catch(setAddError);
			}
			setStep("done");
		} catch (e) {
			setError(e);
			const keys = Object.keys(e instanceof AccountsApiError ? e.fields : {});
			if (keys.some((k) => /^(offer|dpa)_signer/.test(k))) setStep("signers");
		} finally {
			setPending(false);
		}
	};

	const next = (e?: FormEvent) => {
		e?.preventDefault();
		if (need) return setTried(true);
		if (step === "signers") return setStep("dpia");
		void confirm();
	};

	const back = () => {
		const i = ORDER.indexOf(step);
		if (i <= 0) onClose();
		else setStep(ORDER[i - 1] as Step);
	};

	// A choice that moves a signing duty away from the person named: said before it is sent.
	const replacedNow = KINDS.flatMap((kind) => {
		const n = named(kind);
		const h = holders[kind];
		return n && h && h !== n.email && n.email !== myEmail
			? [{ kind, name: n.name }]
			: [];
	});

	const title = task ? taskText(task).title : "";
	const count = ORDER.indexOf(step) + 1;
	const o = who(holders.offer);
	const d = who(holders.dpa);
	const offerOther = o && o.email !== myEmail ? o : null;
	const dpaOther = d && d.email !== myEmail && d.email !== o?.email ? d : null;
	const bothToOther = offerOther !== null && d?.email === o?.email;
	const offerName = offerOther?.name ?? "";
	const offerEmail = offerOther?.email ?? "";
	const dpaName = dpaOther?.name ?? "";
	const dpaEmail = dpaOther?.email ?? "";

	if (adding && room?.me && page)
		return (
			<StepsModal
				opened={opened}
				onClose={onClose}
				title={<Trans>Someone new</Trans>}
				data-testid="who-signs"
			>
				<AddPersonSteps
					me={room.me}
					myEmail={myEmail}
					people={room.people}
					preset={{ signs: [adding] }}
					// With whoever is named now, so choosing someone new in their place says
					// what happens to them first.
					signing={{ docs: signable(room, page), onName: async () => null }}
					onDraft={(p) => {
						const c: Candidate = {
							draft: p,
							email: p.email,
							name: p.name,
							role: p.role,
						};
						setAdded((a) => [...a.filter((x) => x.email !== c.email), c]);
						for (const k of p.signs.length ? p.signs : [adding])
							choose(k, c.email);
					}}
					onSubmit={async () => {
						throw new Error("A draft sends nothing");
					}}
					onCancel={() => setAdding(null)}
					onDone={() => setAdding(null)}
				/>
			</StepsModal>
		);

	return (
		<StepsModal
			opened={opened}
			onClose={onClose}
			title={step === "done" ? <Trans>Thank you</Trans> : title}
			data-testid="who-signs"
		>
			{step === "done" ? (
				<Stack gap="md" data-testid="who-signs-done">
					<Group gap="sm" wrap="nowrap" align="flex-start">
						<CheckCircleIcon
							size={20}
							color="var(--app-success)"
							aria-hidden
							className={classes.icon}
						/>
						<Stack gap="xs">
							{offerOther &&
								(bothToOther ? (
									<Text>
										<Trans>
											We emailed {offerName} at {offerEmail} a link to sign the
											offer and the DPA.
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
										We emailed {dpaName} at {dpaEmail} a link to sign the DPA.
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
					{addError ? <ErrorNotice error={addError} /> : null}
					<ActionRow>
						{offerOther ? (
							<span />
						) : (
							<Button variant="subtle" onClick={onClose}>
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
							<Trans>Step {count} of 2</Trans>
						</Text>
						{step === "signers" && (
							<Stack gap={0}>
								<Rows>
									{KINDS.map((kind) => {
										const holder = who(holders[kind]);
										const holderName = holder?.name ?? "";
										return (
											<TaskLine
												key={kind}
												testId={`signer-row-${kind}`}
												marker={<KindIcon kind="sign" quiet={!holder} />}
												title={signText(kind)}
												fact={
													holder ? (
														holder.email === myEmail ? (
															<You name={holderName} />
														) : (
															// A long address breaks rather than running past a phone's edge.
															<span style={{ overflowWrap: "anywhere" }}>
																{holderName} · {holder.email}
															</span>
														)
													) : (
														<Trans>Nobody yet</Trans>
													)
												}
												actions={
													// Named, and not theirs to change: shown as it is.
													locked(kind) ? null : (
														<Menu position="bottom-start" withinPortal>
															<Menu.Target>
																<Button
																	{...secondary}
																	data-testid={`signer-choose-${kind}`}
																>
																	{holder ? (
																		<Trans>Change</Trans>
																	) : (
																		<Trans>Choose someone</Trans>
																	)}
																</Button>
															</Menu.Target>
															<Menu.Dropdown>
																{candidates.map((c) => (
																	<Menu.Item
																		key={c.email}
																		leftSection={
																			<PersonAvatar person={c} size={28} />
																		}
																		onClick={() => choose(kind, c.email)}
																		data-testid="signer-candidate"
																	>
																		{c.email === myEmail ? (
																			<You name={c.name} />
																		) : (
																			c.name
																		)}
																		{c.outside && (
																			<Text
																				span
																				size="xs"
																				c="dimmed"
																				ml="xs"
																				data-testid="signer-candidate-outside"
																			>
																				<Trans>not added yet</Trans>
																			</Text>
																		)}
																	</Menu.Item>
																))}
																{mayName && (
																	<>
																		<Menu.Divider />
																		<Menu.Item
																			leftSection={
																				<UserPlusIcon size={20} aria-hidden />
																			}
																			onClick={() => setAdding(kind)}
																			data-testid="signer-new"
																		>
																			<Trans>Someone new</Trans>
																		</Menu.Item>
																	</>
																)}
															</Menu.Dropdown>
														</Menu>
													)
												}
											/>
										);
									})}
								</Rows>
								{replacedNow.map((r) => (
									<Text
										key={r.kind}
										size="sm"
										mt="xs"
										data-testid={`signer-replaces-${r.kind}`}
									>
										{r.kind === "dpa"
											? t`${r.name} no longer signs the DPA, and the link we sent them stops working.`
											: t`${r.name} no longer signs the offer, and the link we sent them stops working.`}
									</Text>
								))}
								{tried && need && (
									<Text size="sm" c="var(--app-danger)" mt="xs">
										{need}
									</Text>
								)}
							</Stack>
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
						{error ? <ErrorNotice error={error} /> : null}
						<ActionRow>
							<Button
								variant="subtle"
								onClick={back}
								data-testid="who-signs-back"
								className={classes.back}
							>
								{step === "signers" ? (
									<Trans>Cancel</Trans>
								) : (
									<Trans>Back</Trans>
								)}
							</Button>
							<Button
								{...fitting}
								type="submit"
								variant="filled"
								loading={pending}
								data-testid="who-signs-next"
							>
								<FitLabel>
									{step === "dpia" ? (
										<Trans>Confirm</Trans>
									) : (
										<Trans>Next</Trans>
									)}
								</FitLabel>
							</Button>
						</ActionRow>
					</Stack>
				</form>
			)}
		</StepsModal>
	);
}

/** A row of steps: Back on the left, quiet; the step's action on the right (rules.css). */
function ActionRow({ children }: { children: ReactNode }) {
	return (
		<Group data-steps justify="space-between" wrap="nowrap">
			{children}
		</Group>
	);
}

/** A name with "(you)" after it. */
function You({ name }: { name: string }) {
	return <Trans>{name} (you)</Trans>;
}
