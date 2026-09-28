import type { Access } from "@echo/access";
import { NotFoundError } from "@echo/core";
import type { Signed } from "@echo/http";
import { projectFor } from "./access";
import type { LibraryStorage, Owned } from "./library-storage";
import type { Row } from "./storage";

export interface LibraryDeps {
  readonly library: Pick<LibraryStorage, "latestRunViews" | "view" | "aspect" | "aspectSegment">;
  readonly access: Access;
}

/**
 * The library screens read these through the API instead of Directus. Directus let only
 * staff read view, aspect and aspect_segment; here anyone who may read the project may read
 * its library, the same rule the library's create routes already use.
 */
export async function projectViews(d: LibraryDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "project:read");
  return d.library.latestRunViews(projectId);
}

/** A row outside any project (an orphaned run) is as missing as one that does not exist. */
async function readable(
  d: LibraryDeps,
  who: Signed,
  found: Owned<Row> | null,
  missing: string,
): Promise<Row> {
  if (!found?.projectId) throw new NotFoundError(missing);
  await projectFor(d.access, who, found.projectId, "project:read");
  return found.row;
}

export async function getView(d: LibraryDeps, who: Signed, viewId: string) {
  return readable(d, who, await d.library.view(viewId), "View not found");
}

export async function getAspect(d: LibraryDeps, who: Signed, aspectId: string) {
  return readable(d, who, await d.library.aspect(aspectId), "Aspect not found");
}

export async function getAspectSegment(d: LibraryDeps, who: Signed, id: string) {
  return readable(d, who, await d.library.aspectSegment(id), "Quote not found");
}
