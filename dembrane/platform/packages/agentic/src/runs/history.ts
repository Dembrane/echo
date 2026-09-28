import { stripFocusBlocks } from "./focus";
import { HISTORY_PAGE_SIZE, nonEmptyText, payloadToDict, sanitizeHostVisible } from "./sanitize";
import type { RunsStorage } from "./storage";

export interface TextTurn {
  readonly role: "user" | "assistant";
  content: string;
}

/**
 * A run's turns replayed as model history. User turns prefer the stored prompt, which
 * carries the project framing the raw message lacks. That prompt also baked in the focus
 * selection current at the time; only the latest user turn's focus is current, so earlier
 * turns keep their text and lose their focus block, or the agent stays narrowed to a
 * selection the host has since cleared.
 */
export async function buildMessageHistory(
  store: Pick<RunsStorage, "listEvents">,
  runId: string,
): Promise<TextTurn[]> {
  const history: TextTurn[] = [];
  let after = 0;
  for (;;) {
    const events = await store.listEvents(runId, after, HISTORY_PAGE_SIZE);
    if (!events.length) break;
    for (const e of events) {
      const type = String(e.event_type ?? "");
      if (type !== "user.message" && type !== "assistant.message") continue;
      const payload = payloadToDict(e.payload);
      let content: string | null;
      if (type === "user.message") {
        content = nonEmptyText(payload.agent_prompt_content) ?? nonEmptyText(payload.content);
      } else {
        content = nonEmptyText(payload.content);
        if (content !== null) content = sanitizeHostVisible(content);
      }
      if (content === null) continue;
      history.push({ role: type === "user.message" ? "user" : "assistant", content });
    }
    const last = Number(events.at(-1)?.seq ?? 0);
    if (!Number.isFinite(last) || last <= after) break;
    after = last;
    if (events.length < HISTORY_PAGE_SIZE) break;
  }
  let latestUser = -1;
  for (let i = history.length - 1; i >= 0; i--)
    if (history[i]?.role === "user") {
      latestUser = i;
      break;
    }
  history.forEach((m, i) => {
    if (m.role !== "user" || i === latestUser) return;
    const stripped = stripFocusBlocks(m.content).trim();
    if (stripped) m.content = stripped;
  });
  return history;
}

/**
 * The messages sent to the model for a turn, as the Python client assembled them: history
 * turns with text, then the turn's own message unless history already ends with it.
 */
export function turnMessages(history: readonly TextTurn[], userMessage: string): TextTurn[] {
  const out = history
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .filter((m) => m.content);
  const current = userMessage.trim();
  if (current) {
    const last = out.at(-1);
    if (!(last && last.role === "user" && last.content === current))
      out.push({ role: "user", content: current });
  }
  if (out.length) return out;
  return [{ role: "user", content: current || userMessage }];
}
