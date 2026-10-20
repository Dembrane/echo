import {
  allowanceForProject,
  freeLimits,
  recordingProject,
  setRecordingProject,
  usedThisPeriod,
} from "@dembrane/allowance";
import { NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectAllows, projectFor } from "@dembrane/http";
import type { ProjectDeps } from "./projects";

export type RecordingStatus = {
  free: boolean;
  is_recording_project: boolean;
  recording_project: { id: string; name: string; workspace_id: string | null } | null;
  can_switch: boolean;
  audio_seconds_left: number | null;
  file_limit_seconds: number | null;
};

const UNLIMITED: RecordingStatus = {
  free: false,
  is_recording_project: true,
  recording_project: null,
  can_switch: false,
  audio_seconds_left: null,
  file_limit_seconds: null,
};

async function liveProject(d: ProjectDeps, id: string) {
  const p = await d.store.project(id);
  if (!p || p.deleted_at) throw new NotFoundError("project.not_found");
  return p;
}

/** Which project of a free account takes recordings, and how much audio is left this month. */
export async function recordingStatus(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
): Promise<RecordingStatus> {
  await projectFor(d.access, who, projectId, "project:read");
  const project = await liveProject(d, projectId);
  const now = d.now();
  const a = await allowanceForProject(d.db, project.id, now);
  if (!a) return { ...UNLIMITED };
  const [chosenId, limits, used] = await Promise.all([
    recordingProject(d.db, a),
    freeLimits(d.db, d.now),
    usedThisPeriod(d.db, a),
  ]);
  const chosen = chosenId ? await d.store.project(chosenId) : null;
  const isIt = chosenId === project.id;
  return {
    free: true,
    is_recording_project: isIt,
    recording_project: chosen
      ? { id: chosen.id, name: chosen.name ?? "", workspace_id: chosen.workspace_id }
      : null,
    can_switch:
      !isIt &&
      !project.is_sample &&
      (await projectAllows(d.access, who, project.id, "settings:manage")),
    audio_seconds_left: Math.max(0, limits.audio_seconds_month - used.audio_seconds),
    file_limit_seconds: limits.audio_seconds_conversation,
  };
}

/** Makes this project the account's recording project. A no-op for unlimited accounts. */
export async function useForRecordings(
  d: ProjectDeps,
  who: Signed,
  projectId: string,
): Promise<RecordingStatus> {
  await projectFor(d.access, who, projectId, "settings:manage");
  const project = await liveProject(d, projectId);
  const a = await allowanceForProject(d.db, project.id, d.now());
  if (!a) return { ...UNLIMITED };
  await setRecordingProject(d.db, a, project.id);
  return recordingStatus(d, who, projectId);
}
