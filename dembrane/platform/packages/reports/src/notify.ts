import { type EmailTemplate, sendEmail, subjectOf } from "@dembrane/account";
import type { Parsed } from "@dembrane/queue";
import type { ReportsStorage } from "./storage";

export interface NotifyDeps {
  readonly store: ReportsStorage;
  readonly portalUrl: string;
  readonly jobs: {
    enqueue(
      def: typeof sendEmail,
      payload: Parsed<typeof sendEmail>,
      opts?: { workflowId?: string },
    ): Promise<unknown>;
  };
}

/**
 * Queues one email per opted-in subscriber of a report that is still published, and
 * returns how many. Keyed on the run, so a retried run emails nobody twice.
 */
export async function emailReportSubscribers(
  d: NotifyDeps,
  p: { projectId: string; reportId: number },
  runId: string,
): Promise<number> {
  const report = await d.store.report(String(p.reportId));
  if (!report || report.deleted_at || report.status !== "published") return 0;
  // Canvases are report rows too, and have no subscribers of their own.
  if (report.kind !== "report" || report.project_id !== p.projectId) return 0;
  const language = (report.language as string | null) || "en";
  await d.store.fillUnsubscribeTokens(p.projectId);
  const subscribers = await d.store.reportSubscribers(p.projectId);
  for (const s of subscribers) {
    const email = {
      template: "report_published",
      data: {
        portal_url: d.portalUrl,
        project_id: p.projectId,
        token: s.token,
        conversation_name: s.conversation_name,
      },
    } satisfies EmailTemplate;
    await d.jobs.enqueue(
      sendEmail,
      {
        ...email,
        to: s.email,
        subject: subjectOf(email) ?? "",
        context: `report ${p.reportId} published`,
        language,
      },
      { workflowId: `${runId}:${s.id}` },
    );
  }
  return subscribers.length;
}
