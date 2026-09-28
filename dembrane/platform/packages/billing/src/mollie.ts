import { money2 } from "./money";

/**
 * Mollie as the billing service sees it: customers, consent and recurring payments,
 * mandates, subscriptions, payment links and sales invoices. Objects are Mollie's own
 * JSON, read through the small accessors below. One HTTP implementation, one fake
 * (test/fake-mollie via FakeMollie) used by every test; nothing in tests or parity
 * reaches the real API.
 */
export type MollieObject = Record<string, unknown> & {
  id?: string;
  status?: string;
  metadata?: Record<string, unknown> | null;
};

export class MollieError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = "MollieError";
  }
}

export interface Mollie {
  readonly enabled: boolean;
  readonly testMode: boolean;
  createCustomer(p: {
    name: string;
    email: string;
    metadata?: Record<string, unknown>;
  }): Promise<MollieObject>;
  createFirstPayment(p: {
    customerId: string;
    amountEur: number;
    description: string;
    redirectUrl: string;
    webhookUrl?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<MollieObject>;
  createRecurringPayment(p: {
    customerId: string;
    amountEur: number;
    description: string;
    mandateId?: string | null;
    webhookUrl?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<MollieObject>;
  getPayment(paymentId: string): Promise<MollieObject>;
  /** Newest first. `fromId` is Mollie's inclusive cursor. */
  listCustomerPayments(
    customerId: string,
    opts?: { limit?: number; fromId?: string | null },
  ): Promise<MollieObject[]>;
  listMandates(customerId: string): Promise<MollieObject[]>;
  revokeMandate(customerId: string, mandateId: string): Promise<void>;
  createSubscription(p: {
    customerId: string;
    amountEur: number;
    interval: string;
    description: string;
    startDate?: string | null;
    webhookUrl?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<MollieObject>;
  updateSubscriptionAmount(p: {
    customerId: string;
    subscriptionId: string;
    amountEur: number;
  }): Promise<MollieObject>;
  getSubscription(p: { customerId: string; subscriptionId: string }): Promise<MollieObject>;
  cancelSubscription(p: { customerId: string; subscriptionId: string }): Promise<MollieObject>;
  createPaymentLink(p: {
    amountEur: number;
    description: string;
    webhookUrl?: string | null;
    redirectUrl?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<MollieObject>;
  createSalesInvoice(p: {
    status: string;
    recipient?: Record<string, unknown>;
    lines?: Record<string, unknown>[];
    paymentDetails?: Record<string, unknown> | null;
    isEInvoice?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<MollieObject>;
  getSalesInvoice(invoiceId: string): Promise<MollieObject>;
}

export const amount = (valueEur: number) => ({ currency: "EUR", value: money2(valueEur) });

function link(obj: MollieObject | null | undefined, name: string): string | null {
  const links = (obj?._links ?? {}) as Record<string, { href?: string } | undefined>;
  return links[name]?.href ?? null;
}
export const checkoutUrl = (p: MollieObject | null | undefined) => link(p, "checkout");
export const paymentLinkUrl = (p: MollieObject | null | undefined) => link(p, "paymentLink");
export const salesInvoicePdfUrl = (p: MollieObject | null | undefined) => link(p, "pdfLink");
export const dashboardUrl = (p: MollieObject | null | undefined) => link(p, "dashboard");
export const meta = (p: MollieObject | null | undefined): Record<string, unknown> =>
  (p?.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>;
export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export function amountOf(p: MollieObject | null | undefined): {
  value: string | null;
  currency: string | null;
} {
  const a = (p?.amount ?? {}) as { value?: unknown; currency?: unknown };
  return { value: str(a.value), currency: str(a.currency) };
}

/** Stand-in when no key is configured: every call fails the way the old client did. */
export class UnconfiguredMollie implements Mollie {
  readonly enabled = false;
  readonly testMode = false;
  private fail(): never {
    throw new MollieError("MOLLIE_API_KEY is not configured");
  }
  createCustomer = async () => this.fail();
  createFirstPayment = async () => this.fail();
  createRecurringPayment = async () => this.fail();
  getPayment = async () => this.fail();
  listCustomerPayments = async () => this.fail();
  listMandates = async () => this.fail();
  revokeMandate = async () => this.fail();
  createSubscription = async () => this.fail();
  updateSubscriptionAmount = async () => this.fail();
  getSubscription = async () => this.fail();
  cancelSubscription = async () => this.fail();
  createPaymentLink = async () => this.fail();
  createSalesInvoice = async () => this.fail();
  getSalesInvoice = async () => this.fail();
}

const BASE_URL = "https://api.mollie.com/v2";

/** The real API over fetch. 20s timeout per call, like the old client. */
export class HttpMollie implements Mollie {
  readonly enabled = true;
  readonly testMode: boolean;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.testMode = apiKey.startsWith("test_");
  }

  private async request(method: string, path: string, body?: unknown): Promise<MollieObject> {
    const res = await this.fetchImpl(BASE_URL + path, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new MollieError(
        `Mollie ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    return text ? (JSON.parse(text) as MollieObject) : {};
  }

  private embedded(data: MollieObject, key: string): MollieObject[] {
    const e = (data._embedded ?? {}) as Record<string, MollieObject[] | undefined>;
    return e[key] ?? [];
  }

  createCustomer(p: Parameters<Mollie["createCustomer"]>[0]) {
    return this.request("POST", "/customers", {
      name: p.name,
      email: p.email,
      ...(p.metadata && Object.keys(p.metadata).length && { metadata: p.metadata }),
    });
  }
  createFirstPayment(p: Parameters<Mollie["createFirstPayment"]>[0]) {
    return this.request("POST", "/payments", {
      amount: amount(p.amountEur),
      customerId: p.customerId,
      sequenceType: "first",
      description: p.description,
      redirectUrl: p.redirectUrl,
      ...(p.webhookUrl && { webhookUrl: p.webhookUrl }),
      ...(p.metadata && Object.keys(p.metadata).length && { metadata: p.metadata }),
    });
  }
  createRecurringPayment(p: Parameters<Mollie["createRecurringPayment"]>[0]) {
    return this.request("POST", "/payments", {
      amount: amount(p.amountEur),
      customerId: p.customerId,
      sequenceType: "recurring",
      description: p.description,
      ...(p.mandateId && { mandateId: p.mandateId }),
      ...(p.webhookUrl && { webhookUrl: p.webhookUrl }),
      ...(p.metadata && Object.keys(p.metadata).length && { metadata: p.metadata }),
    });
  }
  getPayment(paymentId: string) {
    return this.request("GET", `/payments/${paymentId}`);
  }
  async listCustomerPayments(
    customerId: string,
    opts: { limit?: number; fromId?: string | null } = {},
  ) {
    let path = `/customers/${customerId}/payments?limit=${opts.limit ?? 50}`;
    if (opts.fromId) path += `&from=${opts.fromId}`;
    return this.embedded(await this.request("GET", path), "payments");
  }
  async listMandates(customerId: string) {
    return this.embedded(
      await this.request("GET", `/customers/${customerId}/mandates`),
      "mandates",
    );
  }
  async revokeMandate(customerId: string, mandateId: string) {
    await this.request("DELETE", `/customers/${customerId}/mandates/${mandateId}`);
  }
  createSubscription(p: Parameters<Mollie["createSubscription"]>[0]) {
    return this.request("POST", `/customers/${p.customerId}/subscriptions`, {
      amount: amount(p.amountEur),
      interval: p.interval,
      description: p.description,
      ...(p.startDate && { startDate: p.startDate }),
      ...(p.webhookUrl && { webhookUrl: p.webhookUrl }),
      ...(p.metadata && Object.keys(p.metadata).length && { metadata: p.metadata }),
    });
  }
  updateSubscriptionAmount(p: Parameters<Mollie["updateSubscriptionAmount"]>[0]) {
    return this.request("PATCH", `/customers/${p.customerId}/subscriptions/${p.subscriptionId}`, {
      amount: amount(p.amountEur),
    });
  }
  getSubscription(p: { customerId: string; subscriptionId: string }) {
    return this.request("GET", `/customers/${p.customerId}/subscriptions/${p.subscriptionId}`);
  }
  cancelSubscription(p: { customerId: string; subscriptionId: string }) {
    return this.request("DELETE", `/customers/${p.customerId}/subscriptions/${p.subscriptionId}`);
  }
  createPaymentLink(p: Parameters<Mollie["createPaymentLink"]>[0]) {
    return this.request("POST", "/payment-links", {
      amount: amount(p.amountEur),
      description: p.description,
      ...(p.webhookUrl && { webhookUrl: p.webhookUrl }),
      ...(p.redirectUrl && { redirectUrl: p.redirectUrl }),
      ...(p.metadata && Object.keys(p.metadata).length && { metadata: p.metadata }),
    });
  }
  createSalesInvoice(p: Parameters<Mollie["createSalesInvoice"]>[0]) {
    return this.request("POST", "/sales-invoices", {
      status: p.status,
      currency: "EUR",
      ...(p.recipient && Object.keys(p.recipient).length && { recipient: p.recipient }),
      ...(p.lines !== undefined && { lines: p.lines }),
      ...(p.paymentDetails &&
        Object.keys(p.paymentDetails).length && { paymentDetails: p.paymentDetails }),
      ...(p.isEInvoice && { isEInvoice: true }),
      ...(p.metadata && Object.keys(p.metadata).length && { metadata: p.metadata }),
    });
  }
  getSalesInvoice(invoiceId: string) {
    return this.request("GET", `/sales-invoices/${invoiceId}`);
  }
}
