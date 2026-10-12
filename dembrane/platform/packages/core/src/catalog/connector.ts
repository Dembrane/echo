import type { Codes } from "./types";

export const connector = {
  "connector.not_configured": {
    action: "none",
    detail: "{provider} is not set up on this deployment",
    description:
      "A connector route was called for an app whose client id, secret or token key is not configured here.",
  },
  "connector.unknown_provider": {
    action: "none",
    detail: "Unknown app: {provider}",
    description: "A connector route named an app dembrane has no connector for.",
    audience: "developer",
  },
  "connector.sign_in_expired": {
    action: "retry",
    detail: "The sign-in with {provider} expired or was started by someone else. Start it again.",
    description:
      "The OAuth callback's state is missing, tampered with, older than ten minutes, or belongs to another signed-in user.",
  },
  "connector.not_connected": {
    action: "fix_input",
    detail: "Connect {provider} first",
    description:
      "The caller has no working connection to the app (never connected, or the app revoked the tokens).",
  },
  "connector.provider_refused": {
    action: "retry",
    detail: "{provider} did not answer as expected",
    description:
      "The app's API refused or failed a request (token exchange, listing boards or frames). The log has its status and body.",
  },
  "connector.board_not_found": {
    action: "fix_input",
    detail: "That board was not found, or your Miro account cannot open it",
    description: "The board id or link names a board the connected Miro account cannot read.",
  },
  "connector.no_frames": {
    action: "fix_input",
    detail: "Pick at least one frame",
    description:
      "A Miro source was saved with no frames, or with frames that are not on the board.",
  },
  "connector.invalid_voice": {
    action: "fix_input",
    detail: "Voice must be one of: participants, organisers, mixed",
    description: "A source named a voice outside participants, organisers and mixed.",
  },
  "connector.source_not_found": {
    action: "none",
    detail: "Source not found",
    description: "The connector source does not exist or belongs to another project.",
  },
} as const satisfies Codes<"connector">;
