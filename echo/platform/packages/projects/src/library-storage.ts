import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { directusRow } from "@echo/legacy-shape";
import { asc, count, desc, eq, inArray } from "drizzle-orm";
import { isUuid, type Row } from "./storage";

const { aspect, aspect_segment, conversation, conversation_segment, project_analysis_run, view } =
  schema;

const ASPECT_FIELDS = {
  id: aspect.id,
  name: aspect.name,
  short_summary: aspect.short_summary,
  long_summary: aspect.long_summary,
  description: aspect.description,
  image_url: aspect.image_url,
  view_id: aspect.view_id,
};

/** A library row and the project that owns it, which is where its access is decided. */
export interface Owned<T> {
  readonly projectId: string | null;
  readonly row: T;
}

/**
 * Reads behind the library screens: views of the latest analysis run, one view, one aspect
 * with its quotes, and one quote. Every read returns the owning project so the service can
 * ask @echo/access before anything leaves.
 */
export function libraryStorage(db: Db) {
  async function aspectsOf(viewIds: string[], byQuotes: boolean) {
    if (!viewIds.length) return new Map<string, Row[]>();
    const rows = byQuotes
      ? await db
          .select({ ...ASPECT_FIELDS, quotes: count(aspect_segment.id) })
          .from(aspect)
          .leftJoin(aspect_segment, eq(aspect_segment.aspect, aspect.id))
          .where(inArray(aspect.view_id, viewIds))
          .groupBy(aspect.id)
          .orderBy(desc(count(aspect_segment.id)), asc(aspect.id))
      : await db
          .select(ASPECT_FIELDS)
          .from(aspect)
          .where(inArray(aspect.view_id, viewIds))
          .orderBy(asc(aspect.id));
    const out = new Map<string, Row[]>();
    for (const r of rows) {
      const { quotes: _quotes, ...fields } = r as typeof r & { quotes?: number };
      const list = out.get(String(r.view_id)) ?? [];
      list.push(directusRow(fields));
      out.set(String(r.view_id), list);
    }
    return out;
  }

  return {
    /** Views of the project's newest analysis run, newest first; none when no run exists. */
    async latestRunViews(projectId: string): Promise<Row[]> {
      const [run] = await db
        .select({ id: project_analysis_run.id })
        .from(project_analysis_run)
        .where(eq(project_analysis_run.project_id, projectId))
        .orderBy(desc(project_analysis_run.created_at))
        .limit(1);
      if (!run) return [];
      const views = await db
        .select({
          id: view.id,
          name: view.name,
          description: view.description,
          created_at: view.created_at,
          user_input: view.user_input,
          user_input_description: view.user_input_description,
        })
        .from(view)
        .where(eq(view.project_analysis_run_id, run.id))
        .orderBy(desc(view.created_at));
      const aspects = await aspectsOf(
        views.map((v) => v.id),
        false,
      );
      return views.map((v) => ({ ...directusRow(v), aspects: aspects.get(v.id) ?? [] }));
    },

    /** One view with its aspects, the ones with most quotes first. */
    async view(viewId: string): Promise<Owned<Row> | null> {
      if (!isUuid(viewId)) return null;
      const [row] = await db
        .select({
          id: view.id,
          name: view.name,
          summary: view.summary,
          description: view.description,
          created_at: view.created_at,
          projectId: project_analysis_run.project_id,
        })
        .from(view)
        .leftJoin(project_analysis_run, eq(project_analysis_run.id, view.project_analysis_run_id))
        .where(eq(view.id, viewId))
        .limit(1);
      if (!row) return null;
      const { projectId, ...fields } = row;
      const aspects = await aspectsOf([row.id], true);
      return { projectId, row: { ...directusRow(fields), aspects: aspects.get(row.id) ?? [] } };
    },

    /** One aspect with its quotes, each quote with the conversation it came from. */
    async aspect(aspectId: string): Promise<Owned<Row> | null> {
      if (!isUuid(aspectId)) return null;
      const [row] = await db
        .select({ ...ASPECT_FIELDS, projectId: project_analysis_run.project_id })
        .from(aspect)
        .leftJoin(view, eq(view.id, aspect.view_id))
        .leftJoin(project_analysis_run, eq(project_analysis_run.id, view.project_analysis_run_id))
        .where(eq(aspect.id, aspectId))
        .limit(1);
      if (!row) return null;
      const { projectId, ...fields } = row;
      const quotes = await db
        .select({
          id: aspect_segment.id,
          description: aspect_segment.description,
          verbatim_transcript: aspect_segment.verbatim_transcript,
          relevant_index: aspect_segment.relevant_index,
          segmentId: conversation_segment.id,
          conversationId: conversation.id,
          participantName: conversation.participant_name,
        })
        .from(aspect_segment)
        .leftJoin(conversation_segment, eq(conversation_segment.id, aspect_segment.segment))
        .leftJoin(conversation, eq(conversation.id, conversation_segment.conversation_id))
        .where(eq(aspect_segment.aspect, aspectId))
        .orderBy(asc(aspect_segment.id));
      return {
        projectId,
        row: {
          ...directusRow(fields),
          aspect_segment: quotes.map((q) => ({
            id: q.id,
            description: q.description,
            verbatim_transcript: q.verbatim_transcript,
            relevant_index: q.relevant_index,
            segment:
              q.segmentId === null
                ? null
                : {
                    id: q.segmentId,
                    conversation_id: q.conversationId
                      ? { id: q.conversationId, participant_name: q.participantName }
                      : null,
                  },
          })),
        },
      };
    },

    /** One quote with the conversation it came from. */
    async aspectSegment(id: string): Promise<Owned<Row> | null> {
      if (!isUuid(id)) return null;
      const [q] = await db
        .select({
          id: aspect_segment.id,
          description: aspect_segment.description,
          verbatim_transcript: aspect_segment.verbatim_transcript,
          relevant_index: aspect_segment.relevant_index,
          segmentId: conversation_segment.id,
          conversationId: conversation.id,
          participantName: conversation.participant_name,
          conversationCreatedAt: conversation.created_at,
          projectId: project_analysis_run.project_id,
        })
        .from(aspect_segment)
        .leftJoin(conversation_segment, eq(conversation_segment.id, aspect_segment.segment))
        .leftJoin(conversation, eq(conversation.id, conversation_segment.conversation_id))
        .leftJoin(aspect, eq(aspect.id, aspect_segment.aspect))
        .leftJoin(view, eq(view.id, aspect.view_id))
        .leftJoin(project_analysis_run, eq(project_analysis_run.id, view.project_analysis_run_id))
        .where(eq(aspect_segment.id, id))
        .limit(1);
      if (!q) return null;
      return {
        projectId: q.projectId,
        row: {
          id: q.id,
          description: q.description,
          verbatim_transcript: q.verbatim_transcript,
          relevant_index: q.relevant_index,
          segment:
            q.segmentId === null
              ? null
              : {
                  conversation_id: q.conversationId
                    ? directusRow({
                        id: q.conversationId,
                        participant_name: q.participantName,
                        created_at: q.conversationCreatedAt,
                      })
                    : null,
                },
        },
      };
    },
  };
}

export type LibraryStorage = ReturnType<typeof libraryStorage>;
