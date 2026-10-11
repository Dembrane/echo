/**
 * Who has to agree before a conversation may train a model. The site's participant policy
 * promises no training unless the client that organised the session opts in, so the
 * client's choice comes first: the project's own setting, else its workspace's, else no.
 * The participant must then have agreed too, recorded on the conversation with the text
 * they agreed to. Both are required; neither alone is enough.
 */
export const AI_TRAINING_VALUES = ["opt-in", "opt-out"] as const;
export type AiTraining = (typeof AI_TRAINING_VALUES)[number];

export interface TrainingInputs {
  readonly projectAiTraining: string | null;
  readonly workspaceAiTraining: string | null;
  readonly trainingConsentAt: string | null;
  readonly trainingConsentVersion: string | null;
  /** A conversation marked deleted never trains, whatever was agreed. */
  readonly deletedAt?: string | null;
}

export type TrainingVerdict =
  | { readonly eligible: true; readonly consentVersion: string }
  | {
      readonly eligible: false;
      readonly reason: "deleted" | "client_not_opted_in" | "participant_not_consented";
    };

/** The client's effective choice: the project's override, else the workspace's, else opt-out. */
export function clientAiTraining(project: string | null, workspace: string | null): AiTraining {
  const pick = (v: string | null) => (v === "opt-in" || v === "opt-out" ? v : null);
  return pick(project) ?? pick(workspace) ?? "opt-out";
}

export function trainingVerdict(i: TrainingInputs): TrainingVerdict {
  if (i.deletedAt) return { eligible: false, reason: "deleted" };
  if (clientAiTraining(i.projectAiTraining, i.workspaceAiTraining) !== "opt-in")
    return { eligible: false, reason: "client_not_opted_in" };
  if (!i.trainingConsentAt || !i.trainingConsentVersion)
    return { eligible: false, reason: "participant_not_consented" };
  return { eligible: true, consentVersion: i.trainingConsentVersion };
}
