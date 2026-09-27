import { createHmac, timingSafeEqual } from "node:crypto";
import { ForbiddenError, UnauthenticatedError } from "@echo/core";

/**
 * The portal's credential for one conversation (CTO decision Q7): an HMAC over the
 * conversation and project ids, issued by initiate and sent back on every call that
 * touches the conversation. It replaces the conversation UUID as the capability; while
 * the portal and the iOS app move over, a call without a token still works unless
 * PARTICIPANT_TOKEN_REQUIRED is on, and a call with a wrong token is always refused.
 */
export const PARTICIPANT_TOKEN_HEADER = "x-participant-token";
const VERSION = "p1";

export interface ParticipantClaims {
  readonly conversationId: string;
  readonly projectId: string;
}

export class ParticipantTokens {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly required: boolean,
  ) {
    // A derived key: the auth secret signs sessions, this signs portal capabilities.
    this.key = createHmac("sha256", secret).update("echo participant token v1").digest();
  }

  issue(c: ParticipantClaims): string {
    const body = Buffer.from(`${c.conversationId}.${c.projectId}`).toString("base64url");
    return `${VERSION}.${body}.${this.sign(body)}`;
  }

  /** The claims of a well-formed, correctly signed token; null otherwise. */
  read(token: string): ParticipantClaims | null {
    const [v, body, sig] = token.split(".");
    if (v !== VERSION || !body || !sig) return null;
    const want = Buffer.from(this.sign(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    const [conversationId, projectId] = Buffer.from(body, "base64url").toString().split(".");
    return conversationId && projectId ? { conversationId, projectId } : null;
  }

  /**
   * Checks a call on one conversation. With a token, it must name this conversation
   * (and project, when the route has one); without, the call passes unless tokens are
   * required. Returns whether a valid token was presented.
   */
  check(header: string | undefined, conversationId: string, projectId?: string): boolean {
    if (!header) {
      if (this.required) throw new UnauthenticatedError("Participant token required");
      return false;
    }
    const claims = this.read(header);
    if (
      !claims ||
      claims.conversationId !== conversationId ||
      (projectId !== undefined && claims.projectId !== projectId)
    )
      throw new ForbiddenError("Invalid participant token");
    return true;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}
