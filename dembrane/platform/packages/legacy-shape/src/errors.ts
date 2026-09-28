import { PlatformError } from "@dembrane/core";

/** 402 with a structured detail: the free-tier limit contract the dashboard keys on. */
export class PaymentRequiredError extends PlatformError {
  readonly status = 402;
  readonly code = "payment_required";
}
