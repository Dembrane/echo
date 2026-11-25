import type { AiProvider } from "@/components/ai-provider/hooks";

/** What the staff editor is changing: the providers an account has and which one is its default. */
export interface ProviderDraft {
	allowed: AiProvider[];
	default: AiProvider;
}

/**
 * Switches a provider on or off. The default cannot be switched off, and one provider always
 * stays, so a switch the rules refuse leaves the draft as it was.
 */
export const setEnabled = (
	draft: ProviderDraft,
	provider: AiProvider,
	on: boolean,
	order: readonly AiProvider[],
): ProviderDraft => {
	if (on === draft.allowed.includes(provider)) return draft;
	if (!on && (provider === draft.default || draft.allowed.length === 1))
		return draft;
	const wanted = on
		? [...draft.allowed, provider]
		: draft.allowed.filter((p) => p !== provider);
	return { ...draft, allowed: order.filter((p) => wanted.includes(p)) };
};

/** Only a provider that is on can be the default. */
export const makeDefault = (
	draft: ProviderDraft,
	provider: AiProvider,
): ProviderDraft =>
	draft.allowed.includes(provider) ? { ...draft, default: provider } : draft;

export const isChanged = (draft: ProviderDraft, saved: ProviderDraft) =>
	draft.default !== saved.default ||
	draft.allowed.length !== saved.allowed.length ||
	draft.allowed.some((p) => !saved.allowed.includes(p));
