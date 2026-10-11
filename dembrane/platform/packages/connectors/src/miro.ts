/**
 * The slice of Miro's REST API the connector uses (developers.miro.com, API v2 for boards and
 * items, v1 for OAuth). Tokens expire after an hour and come with a refresh token valid for
 * 60 days that rotates on every refresh. A frame's items are listed with parent_item_id.
 */

const API = "https://api.miro.com";
export const MIRO_AUTHORIZE_URL = "https://miro.com/oauth/authorize";
/** Pages are at most 50 items; these bound one sync so a huge board cannot run forever. */
const PAGE = 50;
export const MAX_FRAMES = 200;
export const MAX_ITEMS_PER_FRAME = 2000;

export interface MiroTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Seconds; null for a token that does not expire. */
  readonly expiresIn: number | null;
  readonly scope: string | null;
  readonly teamId: string;
  readonly userId: string | null;
}

export interface MiroTeam {
  readonly teamId: string;
  readonly teamName: string | null;
}

export interface MiroBoard {
  readonly id: string;
  readonly name: string;
  readonly url: string | null;
}

export interface MiroFrame {
  readonly id: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
}

/** A widget inside a frame, reduced to what the text rendering needs. */
export interface MiroItem {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Miro answered with a status the caller decides on (401 revoked, 404 gone, 429 busy). */
export class MiroError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Miro answered ${status}: ${body.slice(0, 200)}`);
    this.name = "MiroError";
  }
}

export interface Miro {
  exchange(code: string, redirectUri: string): Promise<MiroTokens>;
  refresh(refreshToken: string): Promise<MiroTokens>;
  team(token: string): Promise<MiroTeam>;
  boards(token: string, query: string | null): Promise<MiroBoard[]>;
  board(token: string, boardId: string): Promise<MiroBoard | null>;
  frames(token: string, boardId: string): Promise<MiroFrame[]>;
  frameItems(token: string, boardId: string, frameId: string): Promise<MiroItem[]>;
}

type Json = Record<string, unknown>;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function httpMiro(opts: { clientId: string; clientSecret: string; fetch?: Fetch }): Miro {
  const f: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));

  async function call(token: string | null, path: string, init: RequestInit = {}): Promise<Json> {
    const res = await f(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new MiroError(res.status, text);
    return text ? (JSON.parse(text) as Json) : {};
  }

  async function oauth(params: Record<string, string>): Promise<MiroTokens> {
    const q = new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      ...params,
    });
    const body = await call(null, `/v1/oauth/token?${q}`, { method: "POST" });
    return {
      accessToken: String(body.access_token ?? ""),
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
      scope: typeof body.scope === "string" ? body.scope : null,
      teamId: String(body.team_id ?? ""),
      userId: body.user_id === undefined ? null : String(body.user_id),
    };
  }

  /** Follows `cursor` until the last page or the cap. */
  async function pages(token: string, path: string, cap: number): Promise<Json[]> {
    const out: Json[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page = await call(
        token,
        `${path}${sep}limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      out.push(...((page.data as Json[] | undefined) ?? []));
      cursor = typeof page.cursor === "string" && page.cursor ? page.cursor : null;
    } while (cursor && out.length < cap);
    return out.slice(0, cap);
  }

  return {
    exchange: (code, redirectUri) =>
      oauth({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => oauth({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async team(token) {
      const body = await call(token, "/v1/oauth-token");
      const team = (body.team as Json | undefined) ?? {};
      return {
        teamId: String(team.id ?? ""),
        teamName: typeof team.name === "string" ? team.name : null,
      };
    },
    async boards(token, query) {
      const q = query?.trim() ? `?query=${encodeURIComponent(query.trim().slice(0, 500))}` : "";
      // One page is enough to pick from; the search narrows it.
      const page = await call(token, `/v2/boards${q}${q ? "&" : "?"}limit=${PAGE}`);
      return ((page.data as Json[] | undefined) ?? []).map(board);
    },
    async board(token, boardId) {
      try {
        return board(await call(token, `/v2/boards/${encodeURIComponent(boardId)}`));
      } catch (err) {
        if (err instanceof MiroError && (err.status === 404 || err.status === 403)) return null;
        throw err;
      }
    },
    async frames(token, boardId) {
      const rows = await pages(
        token,
        `/v2/boards/${encodeURIComponent(boardId)}/items?type=frame`,
        MAX_FRAMES,
      );
      return rows.map((r) => {
        const data = (r.data as Json | undefined) ?? {};
        const pos = (r.position as Json | undefined) ?? {};
        return {
          id: String(r.id),
          title: typeof data.title === "string" ? data.title : "",
          x: num(pos.x),
          y: num(pos.y),
        };
      });
    },
    async frameItems(token, boardId, frameId) {
      const rows = await pages(
        token,
        `/v2/boards/${encodeURIComponent(boardId)}/items?parent_item_id=${encodeURIComponent(frameId)}`,
        MAX_ITEMS_PER_FRAME,
      );
      return rows.map(item);
    },
  };
}

function board(r: Json): MiroBoard {
  return {
    id: String(r.id),
    name: typeof r.name === "string" && r.name ? r.name : "Untitled board",
    url: typeof r.viewLink === "string" ? r.viewLink : null,
  };
}

function item(r: Json): MiroItem {
  const data = (r.data as Json | undefined) ?? {};
  const pos = (r.position as Json | undefined) ?? {};
  const geo = (r.geometry as Json | undefined) ?? {};
  const parts = [data.title, data.content, data.description].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  return {
    id: String(r.id),
    type: String(r.type ?? ""),
    text: parts.join("\n"),
    x: num(pos.x),
    y: num(pos.y),
    width: num(geo.width),
    height: num(geo.height),
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The board id in a Miro link (miro.com/app/board/<id>/) or a bare id; null otherwise. */
export function miroBoardId(input: string): string | null {
  const s = input.trim();
  let id = s;
  if (isMiroLink(s)) {
    const m = new URL(s).pathname.match(/^\/app\/board\/([^/]+)/);
    if (!m) return null;
    id = decodeURIComponent(m[1] as string);
  }
  return /^[A-Za-z0-9_=-]{6,64}$/.test(id) ? id : null;
}

/** A link on miro.com itself (or a subdomain), judged by its parsed host. */
export function isMiroLink(input: string): boolean {
  try {
    const u = new URL(input.trim());
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      (u.hostname === "miro.com" || u.hostname.endsWith(".miro.com"))
    );
  } catch {
    return false;
  }
}

/** A link that opens the board on this frame. Board ids keep their `=` as Miro writes them. */
export function frameLink(boardId: string, frameId: string): string {
  return `https://miro.com/app/board/${boardId}/?moveToWidget=${encodeURIComponent(frameId)}`;
}
