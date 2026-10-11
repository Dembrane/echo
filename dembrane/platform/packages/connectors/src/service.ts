import type { Access } from "@dembrane/access";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  newId,
  StatusError,
  UnavailableError,
} from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { projectFor, type Signed } from "@dembrane/http";
import type { Logger } from "@dembrane/observability";
import type { JobSink } from "@dembrane/queue";
import { syncSource } from "./jobs";
import { MIRO_AUTHORIZE_URL, type Miro, MiroError, miroBoardId } from "./miro";
import { readState, type Sealer, signState } from "./seal";
import type { ConnectionRow, ConnectorStorage, SourceRow } from "./storage";

export const PROVIDERS = ["miro"] as const;
export type Provider = (typeof PROVIDERS)[number];
const LABEL: Record<Provider, string> = { miro: "Miro" };

/** Whose words an input holds. Portal conversations carry null, which reads as participants. */
export const VOICES = ["participants", "organisers", "mixed"] as const;
export type Voice = (typeof VOICES)[number];

/** Miro scope: read boards only. The connector never writes to a board. */
const MIRO_SCOPE = "boards:read";
/** Refresh a little before Miro's hour is up, so a sync never starts on a dying token. */
const REFRESH_MARGIN_MS = 2 * 60_000;

export interface ConnectorDeps {
  readonly db: Db;
  readonly store: ConnectorStorage;
  readonly access: Access;
  readonly jobs: JobSink;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Null when MIRO_CLIENT_* or CONNECTOR_TOKEN_KEY is unset: Miro is hidden. */
  readonly miro: Miro | null;
  readonly sealer: Sealer | null;
  /** Signs the OAuth state (AUTH_SECRET). */
  readonly stateSecret: string;
  /** Public: it is part of the sign-in URL. */
  readonly miroClientId: string | null;
  /** Where Miro sends the browser back: the API's own callback route. */
  readonly miroRedirectUri: string;
  readonly dashboardUrl: string;
}

function provider(raw: string): Provider {
  if ((PROVIDERS as readonly string[]).includes(raw)) return raw as Provider;
  throw new NotFoundError("connector.unknown_provider", { params: { provider: raw } });
}

function miroOf(d: ConnectorDeps): { miro: Miro; sealer: Sealer } {
  if (!d.miro || !d.sealer)
    throw new UnavailableError("connector.not_configured", { params: { provider: "Miro" } });
  return { miro: d.miro, sealer: d.sealer };
}

function appUser(who: Signed): string {
  if (!who.appUserId) throw new ForbiddenError("access.not_onboarded");
  return who.appUserId;
}

export function parseVoice(raw: string): Voice {
  if ((VOICES as readonly string[]).includes(raw)) return raw as Voice;
  throw new BadRequestError("connector.invalid_voice");
}

/** The apps this deployment offers and whether the caller is connected to each. */
export async function providers(d: ConnectorDeps, who: Signed) {
  const user = appUser(who);
  return Promise.all(
    PROVIDERS.map(async (p) => {
      const conn = d.miro && d.sealer ? await d.store.connectionFor(user, p) : null;
      return {
        provider: p,
        label: LABEL[p],
        configured: Boolean(d.miro && d.sealer),
        connected: Boolean(conn),
        account_name: conn?.account_name ?? null,
      };
    }),
  );
}

/** The app's sign-in page, with state tying the callback to this person and project. */
export async function authorizeUrl(
  d: ConnectorDeps,
  who: Signed,
  projectId: string,
  rawProvider: string,
) {
  const p = provider(rawProvider);
  miroOf(d);
  const user = appUser(who);
  await projectFor(d.access, who, projectId, "project:update");
  const state = signState(d.stateSecret, { user, project: projectId, provider: p }, d.now());
  const q = new URLSearchParams({
    response_type: "code",
    client_id: d.miroClientId ?? "",
    redirect_uri: d.miroRedirectUri,
    state,
    scope: MIRO_SCOPE,
  });
  return { url: `${MIRO_AUTHORIZE_URL}?${q}` };
}

/**
 * The browser comes back from the app. Exchanges the code, seals the tokens and answers
 * with where the dashboard should go: the project's integrations page, saying how it went.
 */
export async function completeAuthorization(
  d: ConnectorDeps,
  who: Signed | null,
  rawProvider: string,
  q: { code?: string | undefined; state?: string | undefined; error?: string | undefined },
  projectPath: (projectId: string) => Promise<string | null>,
): Promise<string> {
  const p = provider(rawProvider);
  const { miro, sealer } = miroOf(d);
  const state = q.state ? readState(d.stateSecret, q.state, d.now()) : null;
  const back = async (projectId: string | undefined, status: string) => {
    const path = projectId ? await projectPath(projectId) : null;
    const base = d.dashboardUrl.replace(/\/$/, "");
    return path
      ? `${base}${path}/integrations?connector=${p}&status=${status}`
      : `${base}/?connector=${p}&status=${status}`;
  };
  if (!state || state.provider !== p || !who?.appUserId || state.user !== who.appUserId)
    return back(state?.project, "expired");
  if (q.error || !q.code) return back(state.project, "denied");
  try {
    await projectFor(d.access, who, state.project, "project:update");
    const tokens = await miro.exchange(q.code, d.miroRedirectUri);
    const team = await miro.team(tokens.accessToken).catch(() => null);
    const now = d.now();
    await d.store.saveConnection({
      id: newId(),
      app_user_id: who.appUserId,
      provider: p,
      account_id: tokens.teamId || team?.teamId || "unknown",
      account_name: team?.teamName ?? null,
      external_user_id: tokens.userId,
      access_token: sealer.seal(tokens.accessToken),
      refresh_token: tokens.refreshToken ? sealer.seal(tokens.refreshToken) : null,
      expires_at: tokens.expiresIn ? new Date(now.getTime() + tokens.expiresIn * 1000) : null,
      scope: tokens.scope,
      created_at: now,
      updated_at: now,
    });
    return back(state.project, "connected");
  } catch (err) {
    d.logger.warn({ provider: p, err: (err as Error).message }, "connector sign-in failed");
    return back(state.project, "failed");
  }
}

export async function disconnect(d: ConnectorDeps, who: Signed, rawProvider: string) {
  await d.store.deleteConnections(appUser(who), provider(rawProvider));
}

/**
 * A usable access token for the connection, refreshing it first when it is about to expire.
 * A refresh Miro refuses means the person revoked access or 60 days passed: the connection
 * is removed and the caller is told to connect again.
 */
export async function accessToken(d: ConnectorDeps, conn: ConnectionRow): Promise<string> {
  const { miro, sealer } = miroOf(d);
  const expires = conn.expires_at ? new Date(conn.expires_at).getTime() : null;
  if (expires === null || expires - REFRESH_MARGIN_MS > d.now().getTime())
    return sealer.open(conn.access_token);
  if (!conn.refresh_token)
    throw new BadRequestError("connector.not_connected", { params: { provider: "Miro" } });
  try {
    const t = await miro.refresh(sealer.open(conn.refresh_token));
    const now = d.now();
    await d.store.updateTokens(conn.id, {
      access_token: sealer.seal(t.accessToken),
      refresh_token: t.refreshToken ? sealer.seal(t.refreshToken) : conn.refresh_token,
      expires_at: t.expiresIn ? new Date(now.getTime() + t.expiresIn * 1000) : null,
      updated_at: now,
    });
    return t.accessToken;
  } catch (err) {
    if (err instanceof MiroError && err.status >= 400 && err.status < 500) {
      await d.store.deleteConnections(conn.app_user_id, conn.provider);
      throw new BadRequestError("connector.not_connected", { params: { provider: "Miro" } });
    }
    throw err;
  }
}

/** The caller's own token, for browsing boards while setting up a source. */
async function callerToken(d: ConnectorDeps, who: Signed, projectId: string) {
  miroOf(d);
  await projectFor(d.access, who, projectId, "project:update");
  const conn = await d.store.connectionFor(appUser(who), "miro");
  if (!conn) throw new BadRequestError("connector.not_connected", { params: { provider: "Miro" } });
  return { conn, token: await accessToken(d, conn) };
}

/** Miro's own refusals as the caller's errors: 401 means connect again. */
async function miroCall<T>(d: ConnectorDeps, conn: ConnectionRow, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MiroError) {
      d.logger.warn({ status: err.status, body: err.body.slice(0, 200) }, "miro refused");
      if (err.status === 401) {
        await d.store.deleteConnections(conn.app_user_id, conn.provider);
        throw new BadRequestError("connector.not_connected", { params: { provider: "Miro" } });
      }
      if (err.status === 404 || err.status === 403)
        throw new NotFoundError("connector.board_not_found");
      throw new StatusError(502, "connector.provider_refused", { params: { provider: "Miro" } });
    }
    throw err;
  }
}

export async function boards(
  d: ConnectorDeps,
  who: Signed,
  projectId: string,
  query: string | null,
) {
  const { conn, token } = await callerToken(d, who, projectId);
  const { miro } = miroOf(d);
  // A pasted link or id finds that board directly, even when search would not list it.
  const direct = query ? miroBoardId(query) : null;
  if (direct && query?.includes("miro.com")) {
    const b = await miroCall(d, conn, () => miro.board(token, direct));
    if (!b) throw new NotFoundError("connector.board_not_found");
    return [b];
  }
  return miroCall(d, conn, () => miro.boards(token, query));
}

export async function frames(d: ConnectorDeps, who: Signed, projectId: string, boardId: string) {
  const { conn, token } = await callerToken(d, who, projectId);
  const { miro } = miroOf(d);
  const id = miroBoardId(boardId);
  if (!id) throw new NotFoundError("connector.board_not_found");
  const list = await miroCall(d, conn, () => miro.frames(token, id));
  // Frames in reading order too: top to bottom, then left to right.
  return [...list].sort((a, b) => a.y - b.y || a.x - b.x);
}

function view(s: SourceRow, inputs: number) {
  const settings = (s.settings ?? {}) as { frame_ids?: string[] };
  return {
    id: s.id,
    provider: s.provider,
    external_id: s.external_id,
    name: s.name,
    url: s.url,
    frame_ids: settings.frame_ids ?? [],
    voice: s.voice,
    status: s.status,
    error: s.error,
    connected: Boolean(s.connection_id),
    inputs,
    last_synced_at: s.last_synced_at ? new Date(s.last_synced_at).toISOString() : null,
    created_at: new Date(s.created_at).toISOString(),
  };
}

export async function listSources(d: ConnectorDeps, who: Signed, projectId: string) {
  await projectFor(d.access, who, projectId, "project:read");
  return (await d.store.sources(projectId)).map((r) => view(r.source, Number(r.inputs)));
}

export interface SourceInput {
  readonly provider: string;
  readonly board: string;
  readonly frame_ids: readonly string[];
  readonly voice: string;
}

/** Connects a board's frames to the project and queues the first sync. */
export async function createSource(
  d: ConnectorDeps,
  who: Signed,
  projectId: string,
  input: SourceInput,
) {
  const p = provider(input.provider);
  const voice = parseVoice(input.voice);
  const { conn, token } = await callerToken(d, who, projectId);
  const { miro } = miroOf(d);
  const boardId = miroBoardId(input.board);
  if (!boardId) throw new NotFoundError("connector.board_not_found");
  const board = await miroCall(d, conn, () => miro.board(token, boardId));
  if (!board) throw new NotFoundError("connector.board_not_found");
  const onBoard = new Set(
    (await miroCall(d, conn, () => miro.frames(token, boardId))).map((f) => f.id),
  );
  const frameIds = [...new Set(input.frame_ids)].filter((f) => onBoard.has(f));
  if (!frameIds.length) throw new BadRequestError("connector.no_frames");
  const now = d.now();
  const existing = await d.store.sourceByExternal(projectId, p, boardId);
  let source: SourceRow;
  if (existing) {
    // The same board again: keep one source and widen it to the frames now picked.
    await d.store.updateSource(existing.id, {
      settings: { frame_ids: frameIds },
      voice,
      connection_id: conn.id,
      name: board.name,
      url: board.url,
      status: "pending",
      error: null,
      updated_at: now,
    });
    source = (await d.store.source(existing.id)) as SourceRow;
  } else {
    source = await d.store.insertSource({
      id: newId(),
      project_id: projectId,
      connection_id: conn.id,
      provider: p,
      external_id: boardId,
      name: board.name,
      url: board.url,
      settings: { frame_ids: frameIds },
      voice,
      created_by: who.appUserId,
      status: "pending",
      created_at: now,
      updated_at: now,
    });
  }
  await d.jobs.enqueue(syncSource, { sourceId: source.id }, { singletonKey: source.id });
  return view(source, 0);
}

async function sourceIn(d: ConnectorDeps, projectId: string, sourceId: string) {
  const s = await d.store.source(sourceId);
  if (!s || s.project_id !== projectId) throw new NotFoundError("connector.source_not_found");
  return s;
}

export async function updateSource(
  d: ConnectorDeps,
  who: Signed,
  projectId: string,
  sourceId: string,
  patch: { frame_ids?: readonly string[] | null; voice?: string | null },
) {
  await projectFor(d.access, who, projectId, "project:update");
  const s = await sourceIn(d, projectId, sourceId);
  const set: Parameters<ConnectorStorage["updateSource"]>[1] = { updated_at: d.now() };
  if (patch.voice) set.voice = parseVoice(patch.voice);
  if (patch.frame_ids) {
    if (!patch.frame_ids.length) throw new BadRequestError("connector.no_frames");
    set.settings = { frame_ids: [...new Set(patch.frame_ids)] };
  }
  // Whoever changes the source and is connected takes over syncing it.
  const mine = who.appUserId ? await d.store.connectionFor(who.appUserId, s.provider) : null;
  if (mine) set.connection_id = mine.id;
  await d.store.updateSource(s.id, set);
  await d.jobs.enqueue(syncSource, { sourceId: s.id }, { singletonKey: s.id });
  return view((await d.store.source(s.id)) as SourceRow, (await d.store.inputs(s.id)).length);
}

export async function requestSync(
  d: ConnectorDeps,
  who: Signed,
  projectId: string,
  sourceId: string,
) {
  await projectFor(d.access, who, projectId, "project:update");
  const s = await sourceIn(d, projectId, sourceId);
  await d.jobs.enqueue(syncSource, { sourceId: s.id }, { singletonKey: s.id });
  return { queued: true };
}

/** Removes the source and every input it made. */
export async function deleteSource(
  d: ConnectorDeps,
  who: Signed,
  projectId: string,
  sourceId: string,
) {
  await projectFor(d.access, who, projectId, "project:update");
  const s = await sourceIn(d, projectId, sourceId);
  await d.store.deleteSource(s.id);
}
