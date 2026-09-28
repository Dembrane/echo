import { ConflictError, NotFoundError, zip } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";
import type { ObjectStorage } from "@dembrane/storage";
import type { Person, PrivacyStorage } from "./privacy-storage";

/** How long the export link and the audio links in it work: the most a signed URL allows. */
export const EXPORT_LINK_SECONDS = 7 * 24 * 60 * 60;

export interface PrivacyDeps {
  readonly store: PrivacyStorage;
  /** The file bucket: signed PDFs are read from it and the export is written to it. */
  readonly files: ObjectStorage;
  /** Participant audio; each recording in the export is a signed link, not a copy. */
  readonly audio: ObjectStorage;
  /** The object key of a stored audio path (conversations' AudioUrls.keyOf). */
  readonly audioKeyOf: (path: string) => string;
  readonly logger: Logger;
  readonly now: () => Date;
}

const SECRET_USER_FIELDS = ["password", "token", "tfa_secret", "auth_data"] as const;
const STORAGE_KEY_FIELDS = ["imageKey", "initialsImageKey", "signedPdfKey"] as const;

const omit = <T extends object>(row: T | undefined, keys: readonly string[]) =>
  row ? Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k))) : null;

export async function findPerson(store: PrivacyStorage, email: string): Promise<Person> {
  const p = await store.person(email);
  if (!p) throw new NotFoundError("No user with that email");
  return p;
}

const README = `# Your dembrane data

This is a copy of the personal data dembrane holds about you, as of the date in
manifest.json.

- account.json: your account: name, email, language, sign-in methods and recent sign-ins.
- memberships.json: the organisations, workspaces and projects you belong or belonged to.
- projects.json: the projects you created.
- conversations.json: the conversations in those projects, and conversations you took part
  in with this email address. Where a recording exists, audio_download_url downloads it;
  those links work for 7 days.
- transcripts/: the transcript of each of those conversations, one file each.
- chats.json: the chats you started, with every message.
- documents.json and documents/: documents you signed or were asked to sign, your signatures
  and the signed PDFs.
- activity.json: the notifications sent to you and the record of actions on your account.
- assistant.json: assistants you connected, what they remembered, and feedback and support
  requests you sent.
- invites.json and pricing.json: invitations sent to this address and pricing requests you
  filled in.

A file is left out when there is nothing in it.

Questions? Just reply to the email this came with.
`;

const json = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);
const text = (v: string) => new TextEncoder().encode(v);
const empty = (v: unknown) =>
  Array.isArray(v)
    ? v.length === 0
    : v && typeof v === "object"
      ? Object.values(v).every(empty)
      : v === null || v === undefined;

/**
 * Everything tied to one person, zipped into the file bucket at
 * exports/people/<user id>/<export id>.zip, with a signed link that works for seven days.
 * The erasure deletes these files too, found through the audit rows that name their keys.
 */
export async function exportPerson(d: PrivacyDeps, p: Person, exportId: string, key: string) {
  const now = d.now();
  const s = d.store;
  const account = await s.account(p);
  const memberships = await s.memberships(p.appId);
  const projects = await s.projectsCreated(p.id);
  const projectIds = new Set(projects.map((x) => x.id));
  const conversations = await s.conversations([...projectIds], p.email);
  const chats = await s.chats(p.id);
  const docs = await s.documents(p);
  const audit = await s.audit(p);
  const other = await s.other(p);

  const entries: { name: string; data: Uint8Array<ArrayBuffer> }[] = [];
  const add = (name: string, value: unknown) => {
    if (!empty(value)) entries.push({ name, data: json(value) });
  };

  add("account.json", {
    user: omit(account.directus, SECRET_USER_FIELDS),
    identity: account.auth ?? null,
    profile: account.app ?? null,
    sign_in_methods: account.signIn,
    sessions: account.sessions,
  });
  add("memberships.json", memberships);
  add("projects.json", projects);
  add(
    "conversations.json",
    conversations.map((c) => {
      let audio: string | null = null;
      if (c.merged_audio_path)
        try {
          audio = d.audio.presignDownload(d.audioKeyOf(c.merged_audio_path), {
            expiresInSeconds: EXPORT_LINK_SECONDS,
          });
        } catch (err) {
          d.logger.warn({ err, conversationId: c.id }, "export: no audio link");
        }
      return {
        ...c,
        relation: projectIds.has(c.project_id) ? "in_your_project" : "you_took_part",
        audio_download_url: audio,
      };
    }),
  );
  for (const c of conversations) {
    const lines = await s.transcript(c.id);
    if (lines.length)
      entries.push({
        name: `transcripts/${c.id}.txt`,
        data: text(`${lines.map((l) => l.text).join("\n\n")}\n`),
      });
  }
  add("chats.json", chats);
  add("documents.json", {
    documents: docs.documents,
    signatures: docs.signatures.map((x) => omit(x, STORAGE_KEY_FIELDS)),
    account_ticket_messages: docs.tickets,
  });
  for (const sig of docs.signatures) {
    const pdf = await d.files.get(sig.signedPdfKey);
    if (pdf)
      entries.push({
        name: `documents/${sig.documentId}-signed.pdf`,
        data: new Uint8Array(await pdf.arrayBuffer()),
      });
  }
  add("activity.json", { notifications: other.notifications, ...audit });
  add("assistant.json", {
    connected_assistants: other.grants,
    assistant_memories: other.memories,
    feedback: other.feedback,
    support_requests: other.supportRequests,
  });
  add("invites.json", other.invites);
  add("pricing.json", other.pricing);

  const counts = {
    memberships:
      memberships.orgs.length + memberships.workspaces.length + memberships.projects.length,
    projects: projects.length,
    conversations: conversations.length,
    chats: chats.length,
    signatures: docs.signatures.length,
    documents: docs.documents.length,
    audit_rows:
      audit.staff.length + audit.account.length + audit.agent.length + audit.support.length,
    notifications: other.notifications.length,
  };
  entries.unshift(
    { name: "README.md", data: text(README) },
    {
      name: "manifest.json",
      data: json({ export_id: exportId, generated_at: now.toISOString(), user_id: p.id, counts }),
    },
  );
  const body = zip(entries, now);
  await d.files.put(key, body, "application/zip");
  return {
    export_id: exportId,
    key,
    bytes: body.length,
    files: entries.map((e) => e.name),
    counts,
    download_url: d.files.presignDownload(key, { expiresInSeconds: EXPORT_LINK_SECONDS }),
    expires_at: new Date(now.getTime() + EXPORT_LINK_SECONDS * 1000).toISOString(),
  };
}

/** What an erasure would remove and keep, and whether anything blocks it. */
export async function erasurePlan(store: PrivacyStorage, p: Person) {
  const counts = await store.count(p);
  const soleAdmin = await store.soleAdminOrgs(p.appId);
  const blockers: string[] = [];
  if (p.role === "Administrator")
    blockers.push("staff: revoke first with `bun run staff:access revoke <email> --by <you>`");
  return {
    user_id: p.id,
    app_user_id: p.appId,
    blockers,
    sole_admin_orgs: soleAdmin,
    removes: {
      account: true,
      memberships: counts.memberships,
      private_chats: counts.private_chats,
      connected_assistants: counts.agent_grants,
    },
    keeps: {
      signatures: counts.signatures,
      shared_chats_without_author: counts.shared_chats,
      projects_without_creator: counts.projects_created,
      conversations_as_participant: counts.participant_conversations,
      audit_rows: "kept with the user id only",
    },
  };
}

/**
 * Erases a person after the plan's checks. Refuses staff, and a person who is the last
 * owner or admin of a live organisation unless `allowOrphanOrgs`: that organisation would be
 * left with nobody who can manage it. Files go after the commit; a file that will not delete
 * is logged, since the rows no longer point at it.
 */
export async function erasePerson(
  d: Pick<PrivacyDeps, "store" | "files" | "logger">,
  p: Person,
  opts: { allowOrphanOrgs: boolean },
) {
  const plan = await erasurePlan(d.store, p);
  if (plan.blockers.length) throw new ConflictError(plan.blockers.join("; "));
  if (plan.sole_admin_orgs.length && !opts.allowOrphanOrgs)
    throw new ConflictError(
      `Last owner or admin of ${plan.sole_admin_orgs.map((o) => o.name ?? o.id).join(", ")}: hand the organisation over, or pass allow_orphan_orgs`,
    );
  const exports = await d.store.exportKeys(p.id);
  const { files } = await d.store.erase(p);
  let filesDeleted = 0;
  for (const key of [...files, ...exports])
    try {
      await d.files.delete(key);
      filesDeleted++;
    } catch (err) {
      d.logger.warn({ err, key }, "erasure: file not deleted");
    }
  return { status: "erased", ...plan, files_deleted: filesDeleted };
}
