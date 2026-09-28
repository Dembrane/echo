import { access } from "./access";
import { account } from "./account";
import { agent } from "./agent";
import { agent_access } from "./agent_access";
import { analysis } from "./analysis";
import { announcement } from "./announcement";
import { auth } from "./auth";
import { billing } from "./billing";
import { canvas } from "./canvas";
import { chat } from "./chat";
import { conversation } from "./conversation";
import { demo } from "./demo";
import { document } from "./document";
import { feedback } from "./feedback";
import { field } from "./field";
import { internal } from "./internal";
import { invite } from "./invite";
import { map } from "./map";
import { member } from "./member";
import { memory } from "./memory";
import { notification } from "./notification";
import { offer } from "./offer";
import { organisation } from "./organisation";
import { participant } from "./participant";
import { popcorn } from "./popcorn";
import { present } from "./present";
import { pricing } from "./pricing";
import { privacy } from "./privacy";
import { project } from "./project";
import { question } from "./question";
import { rate_limit } from "./rate_limit";
import { report } from "./report";
import { request } from "./request";
import { staff } from "./staff";
import { tag } from "./tag";
import { task } from "./task";
import { template } from "./template";
import { training } from "./training";
import type { CodeSpec, ErrorAudience, SpecParams } from "./types";
import { upload } from "./upload";
import { validation } from "./validation";
import { verify } from "./verify";
import { webhook } from "./webhook";
import { workspace } from "./workspace";

/**
 * Every error code the platform sends, one file per namespace. A code is stable: clients
 * key their messages on it, so a code is renamed only with its frontend message.
 */
export const ERROR_CATALOG = {
  ...request,
  ...field,
  ...validation,
  ...auth,
  ...access,
  ...internal,
  ...rate_limit,
  ...account,
  ...invite,
  ...member,
  ...organisation,
  ...workspace,
  ...project,
  ...template,
  ...tag,
  ...webhook,
  ...conversation,
  ...upload,
  ...participant,
  ...chat,
  ...memory,
  ...agent,
  ...agent_access,
  ...canvas,
  ...report,
  ...analysis,
  ...map,
  ...present,
  ...popcorn,
  ...verify,
  ...feedback,
  ...notification,
  ...announcement,
  ...training,
  ...billing,
  ...pricing,
  ...document,
  ...task,
  ...offer,
  ...demo,
  ...staff,
  ...privacy,
  ...question,
} as const;

export type ErrorCatalog = typeof ERROR_CATALOG;
export type ErrorCode = keyof ErrorCatalog;
export type ErrorParams<C extends ErrorCode> = SpecParams<ErrorCatalog[C]>;
export type ErrorNamespace = ErrorCode extends `${infer N}.${string}` ? N : never;

type AudienceOf<S extends CodeSpec> = S extends { audience: infer A extends ErrorAudience }
  ? A
  : "user";

/** The codes a person can see on their own screen: each needs a frontend message. */
export type UserErrorCode = {
  [C in ErrorCode]: AudienceOf<ErrorCatalog[C]> extends "user" ? C : never;
}[ErrorCode];

/** The field-level codes a validation error lists per field. */
export type FieldErrorCode = Extract<ErrorCode, `field.${string}`>;

export * from "./types";
