import type { MessageDescriptor } from "@lingui/core";
import type { ErrorCode } from "../catalog/index.gen";
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
import { upload } from "./upload";
import { validation } from "./validation";
import { verify } from "./verify";
import { webhook } from "./webhook";
import { workspace } from "./workspace";

/**
 * Every friendly error message, by code. Loaded on the first error a screen shows (see
 * ../present.ts), never in the first load, so the participant portal stays small.
 */
export const ERROR_MESSAGES: Partial<Record<ErrorCode, MessageDescriptor>> = {
	...access,
	...account,
	...agent,
	...agent_access,
	...analysis,
	...announcement,
	...auth,
	...billing,
	...canvas,
	...chat,
	...conversation,
	...demo,
	...document,
	...feedback,
	...field,
	...internal,
	...invite,
	...map,
	...member,
	...memory,
	...notification,
	...offer,
	...organisation,
	...participant,
	...popcorn,
	...present,
	...pricing,
	...privacy,
	...question,
	...project,
	...rate_limit,
	...report,
	...request,
	...staff,
	...tag,
	...task,
	...template,
	...training,
	...upload,
	...validation,
	...verify,
	...webhook,
	...workspace,
};
