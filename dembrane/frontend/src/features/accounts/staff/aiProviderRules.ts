import type { AiJob, AiProvider } from "@/components/ai-provider/hooks";
import { AI_JOBS } from "@/components/ai-provider/hooks";

/** What the staff editor is changing: the providers enabled for each job and the default of each. */
export interface ProviderDraft {
	enabled: Record<AiJob, AiProvider[]>;
	defaults: Record<AiJob, AiProvider>;
}

/** Which jobs each provider serves: a job can only be set to a provider that serves it. */
export type Serves = Record<AiProvider, readonly AiJob[]>;

/**
 * Switches a provider on or off for one job. The job's default cannot be switched off, one
 * provider always stays, and a provider is only ever on for a job it serves, so a switch the
 * rules refuse leaves the draft as it was.
 */
export const setEnabled = (
	draft: ProviderDraft,
	job: AiJob,
	provider: AiProvider,
	on: boolean,
	order: readonly AiProvider[],
	serves: Serves,
): ProviderDraft => {
	const now = draft.enabled[job];
	if (on === now.includes(provider)) return draft;
	if (on && !serves[provider].includes(job)) return draft;
	if (!on && (provider === draft.defaults[job] || now.length === 1))
		return draft;
	const wanted = on ? [...now, provider] : now.filter((p) => p !== provider);
	return {
		...draft,
		enabled: {
			...draft.enabled,
			[job]: order.filter((p) => wanted.includes(p)),
		},
	};
};

/** Only a provider that is on for the job can be its default. */
export const makeDefault = (
	draft: ProviderDraft,
	job: AiJob,
	provider: AiProvider,
): ProviderDraft =>
	draft.enabled[job].includes(provider)
		? { ...draft, defaults: { ...draft.defaults, [job]: provider } }
		: draft;

/** Whether the switch of a provider for a job is the locked one: on, and the job's default. */
export const isLocked = (
	draft: ProviderDraft,
	job: AiJob,
	provider: AiProvider,
): boolean =>
	draft.defaults[job] === provider && draft.enabled[job].includes(provider);

export const isChanged = (draft: ProviderDraft, saved: ProviderDraft) =>
	AI_JOBS.some(
		(job) =>
			draft.defaults[job] !== saved.defaults[job] ||
			draft.enabled[job].length !== saved.enabled[job].length ||
			draft.enabled[job].some((p) => !saved.enabled[job].includes(p)),
	);
