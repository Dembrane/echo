import { projectMonitor } from "@dembrane/conversations";
import type { Signed } from "@dembrane/http";
import { agentProject } from "../access";
import type { DataDeps } from "./deps";

/**
 * GET /agentic/projects/{p}/monitor: which portal conversations are recording now, their
 * transcription progress and failures, and the visitors still in the pre-conversation
 * funnel. It is the host monitor's own gather over the same presence store, so liveness
 * comes from participant pings (chunk arrival only when a conversation never pinged) and
 * the agent sees exactly what the host sees.
 */
export async function monitor(d: DataDeps, who: Signed, projectId: string, windowSeconds: number) {
  const access = await agentProject(d.access, who, projectId);
  return projectMonitor(
    d,
    projectId,
    windowSeconds,
    { workspaceId: access.project.workspaceId, tier: access.tier },
    d.now(),
  );
}
