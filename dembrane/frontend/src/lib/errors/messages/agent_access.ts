import { msg } from "@lingui/core/macro";
import type { Messages } from "./types";

export const agent_access = {
	"agent_access.expiry_unsupported": msg({
		id: "error.agent_access.expiry_unsupported",
		message: "Pick one of the offered expiry options.",
	}),
	"agent_access.grant_not_found": msg({
		id: "error.agent_access.grant_not_found",
		message:
			"We could not find this agent connection. It may have been removed already.",
	}),
	"agent_access.no_enabled_organisation": msg({
		id: "error.agent_access.no_enabled_organisation",
		message:
			"None of the organisations you picked allow agent access. Pick another one, or ask your admin to switch agent access on.",
	}),
	"agent_access.request_expired": msg({
		id: "error.agent_access.request_expired",
		message:
			"This connection request has expired. Start again from your agent.",
	}),
	"agent_access.risk_not_accepted": msg({
		id: "error.agent_access.risk_not_accepted",
		message: "Accept the data risk notice to connect your agent.",
	}),
} satisfies Messages<"agent_access">;
