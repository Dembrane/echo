import type { Access, ProjectAccess } from "@dembrane/access";
import type { Signed } from "@dembrane/http";
import { projectFor } from "@dembrane/projects";

/**
 * The gate every agentic route shares with the chat BFF (_assert_project_access): any
 * workspace member whose role grants chat:use may drive the assistant. Staff no longer
 * bypass the ladder (spec H-14): they reach a tenant only through a support session. A
 * project the caller cannot reach answers 404; a role without chat:use 403 "Not allowed";
 * a caller who never onboarded 403 "User not onboarded".
 */
export async function agentProject(
  access: Access,
  who: Signed,
  projectId: string,
): Promise<ProjectAccess> {
  return projectFor(access, who, projectId, "chat:use");
}
