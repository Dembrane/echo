import type { AccountsDeps, Conn } from "./deps";
import { emit } from "./events";
import { store } from "./storage";
import { createTask } from "./tasks";

/**
 * Onboarding for someone who signed up: four nudges from the demo to the product, each
 * done by the step itself (opening the demo, clicking the tutorial link, creating a
 * project, a booked call), never by a reply. They are no obligation, so they never send a
 * reminder email, and an offer sent withdraws the ones not taken. Only the demo builder
 * and staff (through the onboarding route, which sam calls once the team says yes) add
 * them; a self-serve signup gets none.
 */

export const ONBOARDING_CODES = [
  "explore_demo",
  "watch_tutorial",
  "create_project",
  "book_call",
] as const;
export type OnboardingCode = (typeof ONBOARDING_CODES)[number];

export const isOnboardingCode = (v: unknown): v is OnboardingCode =>
  typeof v === "string" && (ONBOARDING_CODES as readonly string[]).includes(v);

/** The demo the prospect explores: where "Check out the demo we made for you" leads. */
export interface OnboardingDemo {
  readonly projectId: string;
  readonly workspaceId: string;
}

/**
 * Adds the onboarding tasks the organisation does not have yet, in any status, so a rerun
 * or a second call adds nothing and a withdrawn one stays withdrawn. "Check out the demo"
 * only with a demo to explore. A step the organisation already took is done at once.
 * Returns the codes it added.
 */
export async function ensureOnboardingTasks(
  d: AccountsDeps,
  tx: Conn,
  orgId: string,
  opts: { demo: OnboardingDemo | null; createdBy: string | null },
): Promise<OnboardingCode[]> {
  const have = new Set((await store.tasks(tx, orgId)).map((t) => t.code));
  const workspaceId = opts.demo?.workspaceId ?? (await store.firstWorkspace(tx, orgId));
  const params: Record<OnboardingCode, Record<string, string>> = {
    explore_demo: opts.demo
      ? { project_id: opts.demo.projectId, workspace_id: opts.demo.workspaceId }
      : {},
    watch_tutorial: {},
    create_project: workspaceId ? { workspace_id: workspaceId } : {},
    book_call: {},
  };
  const now = d.now().getTime();
  const added: OnboardingCode[] = [];
  for (const [i, code] of ONBOARDING_CODES.entries()) {
    if (have.has(code) || (code === "explore_demo" && !opts.demo)) continue;
    await createTask(d, tx, {
      orgId,
      code,
      params: params[code],
      title: null,
      kind: "generic",
      remind: false,
      createdBy: opts.createdBy,
      // A millisecond apart, so they list in the order a prospect takes them.
      createdAt: new Date(now + i),
    });
    added.push(code);
  }
  if (added.length)
    for (const code of await store.onboardingAlreadyDone(tx, orgId))
      if (added.includes(code as OnboardingCode))
        await settled(d, tx, await store.settleOpenByCode(tx, orgId, code, d.now()), code);
  return added;
}

/**
 * Once an offer is sent the prospect has one thing to do, sign it, so the onboarding steps
 * they did not take are withdrawn and the tasks page, the sidebar count and the popup show
 * only the offer's tasks. The steps they took stay done. Returns the codes withdrawn.
 */
export async function withdrawOnboarding(
  d: AccountsDeps,
  tx: Conn,
  orgId: string,
  actor: { kind: "staff"; userId: string },
): Promise<string[]> {
  const rows = await store.withdrawUnfinished(tx, orgId, ONBOARDING_CODES, d.now());
  const codes = rows.map((r) => r.code as string);
  if (codes.length)
    await emit(d, tx, { orgId, actor, type: "onboarding.withdrawn", detail: { codes } });
  return codes;
}

/** Each settled task on the timeline: staff see which step the prospect took, and when. */
async function settled(
  d: AccountsDeps,
  tx: Conn,
  rows: readonly { id: string; orgId: string }[],
  code: string,
) {
  for (const r of rows)
    await emit(d, tx, {
      orgId: r.orgId,
      actor: { kind: "system", userId: null },
      type: "task.done",
      subject: { type: "task", id: r.id },
      detail: { code },
    });
}

/**
 * Runs a completion so that it can never fail the action that triggered it: a page load,
 * a new project or a booking matters more than its checkbox, so a failure is logged and
 * the step stays open.
 */
async function quietly(
  d: Pick<AccountsDeps, "logger">,
  trigger: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    d.logger.warn(
      {
        trigger,
        err: { message: err instanceof Error ? err.message : String(err) },
        signal: "accounts.onboarding_complete_failed",
      },
      "onboarding task not completed",
    );
  }
}

/** Marks the organisation's open onboarding task `code` done; twice is the same as once. */
export function completeOnboarding(
  d: AccountsDeps,
  orgId: string,
  code: OnboardingCode,
): Promise<void> {
  return quietly(d, code, () =>
    d.db.transaction(async (tx) =>
      settled(d, tx, await store.settleOpenByCode(tx, orgId, code, d.now()), code),
    ),
  );
}

/**
 * What other parts of the product tell accounts, wired by the API: a project opened in
 * the dashboard, a project created. None of them ever throws.
 */
export interface OnboardingSignals {
  projectOpened(projectId: string, appUserId: string | null): Promise<void>;
  projectCreated(projectId: string): Promise<void>;
}

export function onboardingSignals(d: AccountsDeps): OnboardingSignals {
  return {
    // Runs on every project load, so a read on the organisation's open tasks comes first
    // and the write happens only for an organisation whose demo step is still open.
    projectOpened: (projectId, appUserId) =>
      appUserId
        ? quietly(d, "explore_demo", async () => {
            if (!(await store.demoStepOpen(d.db, projectId))) return;
            await d.db.transaction(async (tx) =>
              settled(
                d,
                tx,
                await store.settleDemoOpened(tx, projectId, appUserId, d.now()),
                "explore_demo",
              ),
            );
          })
        : Promise.resolve(),
    projectCreated: (projectId) =>
      quietly(d, "create_project", () =>
        d.db.transaction(async (tx) =>
          settled(
            d,
            tx,
            await store.settleProjectCreated(tx, projectId, d.now()),
            "create_project",
          ),
        ),
      ),
  };
}
