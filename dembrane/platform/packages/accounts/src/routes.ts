import { UnavailableError, ValidationError } from "@dembrane/core";
import { type Ctx, type Env, requireUser } from "@dembrane/http";
import { Hono } from "hono";
import { staffCan } from "./access";
import * as K from "./contract";
import {
  accountPage,
  customerFile,
  customerReply,
  declineDocument,
  documentDetail,
  MAX_TASK_FILE_BYTES,
  markViewed,
  mySigningRequests,
  nameSigner,
  openTicket,
  readBilling,
  readDocument,
  recordBooking,
  submitTask,
  type TaskFile,
  tasksSummary,
  updateBilling,
} from "./customer";
import { createDemo, demoStatus, listDemos, publishDemo, retryDemo } from "./demo/service";
import type { AccountsDeps } from "./deps";
import { createAccount } from "./prospect";
import { signDocument } from "./signing";
import {
  accountCard,
  closeTicket,
  documentFields,
  enableAccount,
  listAccounts,
  pushDocument,
  pushOffer,
  reviewTask,
  sendDocument,
  setDocumentFields,
  staffCreateTask,
  staffDocument,
  staffFile,
  staffOpenTicket,
  staffReply,
  updateAccount,
  upsertInvoice,
  voidDocument,
} from "./staff";
import { body, parse } from "./validate";

/** A base64 PDF from a JSON body, checked to be one. */
function pdfBytes(b64: string | null): Uint8Array | null {
  if (!b64) return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-")
    throw new ValidationError("document.pdf_invalid");
  return new Uint8Array(bytes);
}

function requestMeta(c: Ctx) {
  // Cloud Run puts the client first in X-Forwarded-For.
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return { ip: forwarded || null, userAgent: c.req.header("user-agent")?.slice(0, 500) ?? null };
}

function pdfResponse(c: Ctx, bytes: Uint8Array, name: string) {
  return c.body(bytes as unknown as ArrayBuffer, 200, {
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="${name.replace(/[^A-Za-z0-9._ -]+/g, "_")}.pdf"`,
    "cache-control": "private, no-store",
  });
}

/** Task replies arrive as JSON (`response_text`) or multipart (`response_text` plus `file`). */
async function taskSubmission(c: Ctx): Promise<{ text: string | null; file: TaskFile | null }> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data")) {
    const b = await body(c, K.TaskSubmitRequest);
    return { text: b.response_text, file: null };
  }
  const form = await c.req.formData();
  const t = form.get("response_text");
  const f = form.get("file");
  let file: TaskFile | null = null;
  if (f && typeof f !== "string") {
    const blob = f as unknown as File;
    if (blob.size > MAX_TASK_FILE_BYTES)
      throw new ValidationError("upload.too_large", { params: { max_mb: 20 } });
    file = {
      name: blob.name || "file",
      type: blob.type,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    };
  }
  const parsed = parse(K.TaskSubmitRequest, { response_text: typeof t === "string" ? t : null });
  return { text: parsed.response_text, file };
}

const p = (c: Ctx, name: string) => c.req.param(name) as string;

/**
 * The routes of contract.ts (ROUTES): customer routes under /api/v2/orgs/:orgId/account
 * (org owners, admins and billing; a named signer reaches one document), staff and sam
 * routes under /api/v2/admin/accounts (staff:accounts, audited before the body is read).
 * Bodies parse with the contract's schemas; access is decided in access.ts through the
 * service each route calls, never here.
 */
export function accountsRoutes(d: AccountsDeps) {
  const app = new Hono<Env>();
  const R = K.ROUTES;

  // ── customer ────────────────────────────────────────────────────────
  app.get(R.accountPage.path, async (c) =>
    c.json(await accountPage(d, requireUser(c), p(c, "orgId"))),
  );
  app.get(R.readDocument.path, async (c) =>
    c.json(await readDocument(d, requireUser(c), p(c, "orgId"), p(c, "docId"))),
  );
  app.post(R.viewDocument.path, async (c) =>
    c.json(await markViewed(d, requireUser(c), p(c, "orgId"), p(c, "docId"))),
  );
  app.post(R.signDocument.path, async (c) => {
    const who = requireUser(c);
    const input = await body(c, K.SignRequest);
    return c.json(await signDocument(d, who, p(c, "orgId"), p(c, "docId"), input, requestMeta(c)));
  });
  app.post(R.declineDocument.path, async (c) => {
    const who = requireUser(c);
    const b = await body(c, K.DeclineRequest);
    return c.json(await declineDocument(d, who, p(c, "orgId"), p(c, "docId"), b.reason));
  });
  app.post(R.nameSigner.path, async (c) => {
    const who = requireUser(c);
    const b = await body(c, K.NameSignerRequest);
    return c.json(await nameSigner(d, who, p(c, "orgId"), p(c, "docId"), b));
  });
  app.get(R.documentFile.path, async (c) => {
    const r = await customerFile(d, requireUser(c), p(c, "orgId"), p(c, "docId"), "file");
    return pdfResponse(c, r.bytes, r.doc.title);
  });
  app.get(R.signedPdf.path, async (c) => {
    const r = await customerFile(d, requireUser(c), p(c, "orgId"), p(c, "docId"), "signed");
    return pdfResponse(c, r.bytes, `${r.doc.title} (signed)`);
  });
  app.get(R.readBilling.path, async (c) =>
    c.json(await readBilling(d, requireUser(c), p(c, "orgId"))),
  );
  app.put(R.updateBilling.path, async (c) => {
    const who = requireUser(c);
    return c.json(
      await updateBilling(d, who, p(c, "orgId"), await body(c, K.BillingUpdateRequest)),
    );
  });
  app.post(R.submitTask.path, async (c) => {
    const who = requireUser(c);
    const input = await taskSubmission(c);
    return c.json(await submitTask(d, who, p(c, "orgId"), p(c, "taskId"), input));
  });
  app.post(R.openTicket.path, async (c) => {
    const who = requireUser(c);
    return c.json(await openTicket(d, who, p(c, "orgId"), await body(c, K.TicketOpenRequest)), 201);
  });
  app.post(R.replyTicket.path, async (c) => {
    const who = requireUser(c);
    const b = await body(c, K.TicketReplyRequest);
    return c.json(await customerReply(d, who, p(c, "orgId"), p(c, "ticketId"), b.body));
  });
  app.post(R.recordBooking.path, async (c) => {
    const who = requireUser(c);
    return c.json(await recordBooking(d, who, p(c, "orgId"), await body(c, K.BookingRequest)));
  });
  app.get(R.signingRequests.path, async (c) => c.json(await mySigningRequests(d, requireUser(c))));
  app.get(R.tasksSummary.path, async (c) => c.json(await tasksSummary(d, requireUser(c))));

  // ── staff and sam ───────────────────────────────────────────────────
  /** staff:accounts, with its audit row written before the body is read. */
  const staff = async (c: Ctx, action: string, withOrg = true) => {
    const who = requireUser(c);
    const target = withOrg ? { type: "org", id: p(c, "orgId") } : undefined;
    await staffCan(d, who, action, target, c.get("requestId"));
    return who;
  };

  // Demos first: their paths would otherwise match /:orgId.
  const demoSettings = () => {
    if (!d.settings.demo) throw new UnavailableError("demo.not_configured");
    return d.settings.demo;
  };
  const demo = (c: Ctx) => ({ type: "demo", id: p(c, "demoId") });
  app.get(R.listDemos.path, async (c) => {
    await staff(c, "accounts.demo.list", false);
    return c.json(await listDemos(d));
  });
  app.post(R.createDemo.path, async (c) => {
    const who = requireUser(c);
    await staffCan(d, who, "accounts.demo.create", undefined, c.get("requestId"));
    const b = await body(c, K.DemoCreateRequest);
    return c.json(await createDemo(d, demoSettings(), who, b), 201);
  });
  app.get(R.demoStatus.path, async (c) => {
    await staffCan(d, requireUser(c), "accounts.demo.read", demo(c), c.get("requestId"));
    return c.json(await demoStatus(d, p(c, "demoId")));
  });
  app.post(R.publishDemo.path, async (c) => {
    const who = requireUser(c);
    await staffCan(d, who, "accounts.demo.publish", demo(c), c.get("requestId"));
    const b = await body(c, K.DemoPublishRequest);
    return c.json(await publishDemo(d, who, p(c, "demoId"), { sign_in: b.sign_in ?? null }));
  });
  app.post(R.retryDemo.path, async (c) => {
    await staffCan(d, requireUser(c), "accounts.demo.retry", demo(c), c.get("requestId"));
    return c.json(await retryDemo(d, p(c, "demoId")));
  });

  app.get(R.listAccounts.path, async (c) => {
    await staff(c, "accounts.list", false);
    return c.json(await listAccounts(d, parse(K.AccountListQuery, c.req.query())));
  });
  app.post(R.createAccount.path, async (c) => {
    const who = await staff(c, "accounts.create", false);
    return c.json(await createAccount(d, who, await body(c, K.CreateAccountRequest)), 201);
  });
  app.post(R.enableAccount.path, async (c) => {
    const who = await staff(c, "accounts.enable");
    return c.json(
      await enableAccount(d, who, p(c, "orgId"), await body(c, K.EnableAccountRequest)),
    );
  });
  app.get(R.accountCard.path, async (c) => {
    await staff(c, "accounts.card");
    return c.json(await accountCard(d, p(c, "orgId")));
  });
  app.patch(R.updateAccount.path, async (c) => {
    const who = await staff(c, "accounts.update");
    return c.json(
      await updateAccount(d, who, p(c, "orgId"), await body(c, K.UpdateAccountRequest)),
    );
  });
  app.post(R.pushOffer.path, async (c) => {
    const who = await staff(c, "accounts.offer.push");
    return c.json(await pushOffer(d, who, p(c, "orgId"), await body(c, K.PushOfferRequest)), 201);
  });
  app.post(R.pushDocument.path, async (c) => {
    const who = await staff(c, "accounts.document.push");
    const b = await body(c, K.PushDocumentRequest);
    return c.json(
      await pushDocument(d, who, p(c, "orgId"), {
        ...b,
        pdf: pdfBytes(b.pdf_base64),
        fields: b.fields,
      }),
      201,
    );
  });
  app.get(R.staffReadDocument.path, async (c) => {
    await staff(c, "accounts.document.read");
    return c.json(
      await documentDetail(d, await staffDocument(d, p(c, "orgId"), p(c, "docId")), "staff"),
    );
  });
  app.get(R.staffDocumentFile.path, async (c) => {
    await staff(c, "accounts.document.file");
    const r = await staffFile(d, p(c, "orgId"), p(c, "docId"), "file");
    return pdfResponse(c, r.bytes, r.doc.title);
  });
  app.get(R.staffSignedPdf.path, async (c) => {
    await staff(c, "accounts.document.signed_pdf");
    const r = await staffFile(d, p(c, "orgId"), p(c, "docId"), "signed");
    return pdfResponse(c, r.bytes, `${r.doc.title} (signed)`);
  });
  app.get(R.staffDocumentFields.path, async (c) => {
    await staff(c, "accounts.document.fields.read");
    return c.json(await documentFields(d, p(c, "orgId"), p(c, "docId")));
  });
  app.put(R.setDocumentFields.path, async (c) => {
    const who = await staff(c, "accounts.document.fields.set");
    const b = await body(c, K.SetFieldsRequest);
    return c.json(await setDocumentFields(d, who, p(c, "orgId"), p(c, "docId"), b.fields));
  });
  app.post(R.sendDocument.path, async (c) => {
    const who = await staff(c, "accounts.document.send");
    const b = await body(c, K.SendDocumentRequest);
    return c.json(await sendDocument(d, who, p(c, "orgId"), p(c, "docId"), b.task));
  });
  app.post(R.voidDocument.path, async (c) => {
    const who = await staff(c, "accounts.document.void");
    const b = await body(c, K.VoidRequest);
    return c.json(await voidDocument(d, who, p(c, "orgId"), p(c, "docId"), b.reason));
  });
  app.put(R.upsertInvoice.path, async (c) => {
    const who = await staff(c, "accounts.invoice.upsert");
    const exactId = parse(K.ExactId, p(c, "exactId"));
    const b = await body(c, K.InvoiceUpsertRequest);
    return c.json(
      await upsertInvoice(d, who, p(c, "orgId"), exactId, { ...b, pdf: pdfBytes(b.pdf_base64) }),
    );
  });
  app.post(R.createTask.path, async (c) => {
    const who = await staff(c, "accounts.task.create");
    return c.json(
      await staffCreateTask(d, who, p(c, "orgId"), await body(c, K.CreateTaskRequest)),
      201,
    );
  });
  app.post(R.reviewTask.path, async (c) => {
    const who = await staff(c, "accounts.task.review");
    const b = await body(c, K.ReviewTaskRequest);
    return c.json(await reviewTask(d, who, p(c, "orgId"), p(c, "taskId"), b.decision, b.note));
  });
  app.post(R.staffOpenTicket.path, async (c) => {
    const who = await staff(c, "accounts.ticket.open");
    return c.json(
      await staffOpenTicket(d, who, p(c, "orgId"), await body(c, K.StaffTicketOpenRequest)),
      201,
    );
  });
  app.post(R.staffReplyTicket.path, async (c) => {
    const who = await staff(c, "accounts.ticket.reply");
    const b = await body(c, K.StaffReplyRequest);
    return c.json(await staffReply(d, who, p(c, "orgId"), p(c, "ticketId"), b));
  });
  app.post(R.closeTicket.path, async (c) => {
    const who = await staff(c, "accounts.ticket.close");
    return c.json(await closeTicket(d, who, p(c, "orgId"), p(c, "ticketId")));
  });
  return app;
}
