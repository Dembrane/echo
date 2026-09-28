import { amount, type Mollie, MollieError, type MollieObject } from "./mollie";

type Method = keyof Omit<Mollie, "enabled" | "testMode">;

/**
 * In-memory Mollie with the behaviour the billing service relies on: payments newest
 * first with an inclusive `from` cursor, a consent payment that yields a valid mandate
 * once paid, subscriptions that remember their amount and next payment date. Tests
 * settle payments with `settle()` and inject failures with `failNext()`.
 */
export class FakeMollie implements Mollie {
  readonly enabled = true;
  readonly testMode = true;
  readonly calls: { method: Method; args: unknown }[] = [];
  readonly customers = new Map<string, MollieObject>();
  readonly payments = new Map<string, MollieObject>();
  readonly mandates = new Map<string, MollieObject[]>();
  readonly subscriptions = new Map<string, MollieObject>();
  readonly paymentLinks = new Map<string, MollieObject>();
  readonly salesInvoices = new Map<string, MollieObject>();
  /** Status a new off-session (recurring) charge comes back with. */
  recurringStatus = "paid";
  private seq = 0;
  private readonly failures = new Map<Method, MollieError[]>();

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq.toString().padStart(6, "0")}`;
  }

  private stamp(): string {
    // Strictly increasing so "newest first" is deterministic.
    return new Date(Date.UTC(2026, 0, 1) + this.seq * 1000).toISOString();
  }

  failNext(method: Method, error = new MollieError(`${method} failed`, 500)): void {
    const list = this.failures.get(method) ?? [];
    list.push(error);
    this.failures.set(method, list);
  }

  private enter(method: Method, args: unknown): void {
    this.calls.push({ method, args });
    const err = this.failures.get(method)?.shift();
    if (err) throw err;
  }

  callsOf(method: Method): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  addMandate(customerId: string, m: Partial<MollieObject> = {}): MollieObject {
    const mandate: MollieObject = {
      id: this.id("mdt"),
      status: "valid",
      method: "creditcard",
      details: { cardNumber: "4242" },
      createdAt: this.stamp(),
      ...m,
    };
    // Mollie lists mandates newest first.
    this.mandates.set(customerId, [mandate, ...(this.mandates.get(customerId) ?? [])]);
    return mandate;
  }

  /** Moves a payment to a status; a paid consent payment leaves a valid mandate behind. */
  settle(paymentId: string, status: string): MollieObject {
    const p = this.payments.get(paymentId);
    if (!p) throw new Error(`no payment ${paymentId}`);
    p.status = status;
    if (status === "paid" && p.sequenceType === "first") this.addMandate(String(p.customerId));
    return p;
  }

  async createCustomer(p: Parameters<Mollie["createCustomer"]>[0]) {
    this.enter("createCustomer", p);
    const c: MollieObject = { id: this.id("cst"), ...p };
    this.customers.set(c.id as string, c);
    return c;
  }

  private addPayment(p: MollieObject): MollieObject {
    this.payments.set(p.id as string, p);
    return p;
  }

  async createFirstPayment(p: Parameters<Mollie["createFirstPayment"]>[0]) {
    this.enter("createFirstPayment", p);
    const id = this.id("tr");
    return this.addPayment({
      id,
      status: "open",
      sequenceType: "first",
      customerId: p.customerId,
      amount: amount(p.amountEur),
      description: p.description,
      metadata: p.metadata ?? null,
      createdAt: this.stamp(),
      _links: { checkout: { href: `https://mollie.test/checkout/${id}` } },
    });
  }

  async createRecurringPayment(p: Parameters<Mollie["createRecurringPayment"]>[0]) {
    this.enter("createRecurringPayment", p);
    return this.addPayment({
      id: this.id("tr"),
      status: this.recurringStatus,
      sequenceType: "recurring",
      customerId: p.customerId,
      mandateId: p.mandateId ?? null,
      amount: amount(p.amountEur),
      description: p.description,
      metadata: p.metadata ?? null,
      createdAt: this.stamp(),
    });
  }

  /** A renewal charge Mollie creates on its own for a subscription. */
  renew(subscriptionId: string, status: string): MollieObject {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`no subscription ${subscriptionId}`);
    return this.addPayment({
      id: this.id("tr"),
      status,
      sequenceType: "recurring",
      customerId: sub.customerId,
      subscriptionId,
      amount: sub.amount,
      metadata: sub.metadata ?? null,
      createdAt: this.stamp(),
    });
  }

  async getPayment(paymentId: string) {
    this.enter("getPayment", paymentId);
    const p = this.payments.get(paymentId);
    if (!p) throw new MollieError(`Mollie GET /payments/${paymentId} -> 404`, 404);
    return p;
  }

  async listCustomerPayments(
    customerId: string,
    opts: { limit?: number; fromId?: string | null } = {},
  ) {
    this.enter("listCustomerPayments", { customerId, ...opts });
    const all = [...this.payments.values()]
      .filter((p) => p.customerId === customerId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const start = opts.fromId ? all.findIndex((p) => p.id === opts.fromId) : 0;
    return all.slice(Math.max(start, 0), Math.max(start, 0) + (opts.limit ?? 50));
  }

  async listMandates(customerId: string) {
    this.enter("listMandates", customerId);
    return [...(this.mandates.get(customerId) ?? [])];
  }

  async revokeMandate(customerId: string, mandateId: string) {
    this.enter("revokeMandate", { customerId, mandateId });
    const m = (this.mandates.get(customerId) ?? []).find((x) => x.id === mandateId);
    if (m) m.status = "revoked";
  }

  async createSubscription(p: Parameters<Mollie["createSubscription"]>[0]) {
    this.enter("createSubscription", p);
    const sub: MollieObject = {
      id: this.id("sub"),
      status: "active",
      customerId: p.customerId,
      amount: amount(p.amountEur),
      interval: p.interval,
      description: p.description,
      nextPaymentDate: p.startDate ?? null,
      metadata: p.metadata ?? null,
    };
    this.subscriptions.set(sub.id as string, sub);
    return sub;
  }

  async updateSubscriptionAmount(p: Parameters<Mollie["updateSubscriptionAmount"]>[0]) {
    this.enter("updateSubscriptionAmount", p);
    const sub = this.subscriptions.get(p.subscriptionId);
    if (!sub) throw new MollieError("subscription not found", 404);
    sub.amount = amount(p.amountEur);
    return sub;
  }

  async getSubscription(p: { customerId: string; subscriptionId: string }) {
    this.enter("getSubscription", p);
    const sub = this.subscriptions.get(p.subscriptionId);
    if (!sub) throw new MollieError("subscription not found", 404);
    return sub;
  }

  async cancelSubscription(p: { customerId: string; subscriptionId: string }) {
    this.enter("cancelSubscription", p);
    const sub = this.subscriptions.get(p.subscriptionId);
    if (!sub) throw new MollieError("subscription not found", 404);
    sub.status = "canceled";
    sub.nextPaymentDate = null;
    return sub;
  }

  async createPaymentLink(p: Parameters<Mollie["createPaymentLink"]>[0]) {
    this.enter("createPaymentLink", p);
    const id = this.id("pl");
    const link: MollieObject = {
      id,
      amount: amount(p.amountEur),
      description: p.description,
      metadata: p.metadata ?? null,
      _links: { paymentLink: { href: `https://mollie.test/pay/${id}` } },
    };
    this.paymentLinks.set(id, link);
    return link;
  }

  async createSalesInvoice(p: Parameters<Mollie["createSalesInvoice"]>[0]) {
    this.enter("createSalesInvoice", p);
    const id = this.id("invoice");
    const inv: MollieObject = {
      id,
      status: p.status,
      recipient: p.recipient ?? null,
      lines: p.lines ?? [],
      paymentDetails: p.paymentDetails ?? null,
      isEInvoice: p.isEInvoice ?? false,
      metadata: p.metadata ?? null,
      _links: { pdfLink: { href: `https://mollie.test/invoices/${id}.pdf` } },
    };
    this.salesInvoices.set(id, inv);
    return inv;
  }

  async getSalesInvoice(invoiceId: string) {
    this.enter("getSalesInvoice", invoiceId);
    const inv = this.salesInvoices.get(invoiceId);
    if (!inv) throw new MollieError(`Mollie GET /sales-invoices/${invoiceId} -> 404`, 404);
    return inv;
  }
}
