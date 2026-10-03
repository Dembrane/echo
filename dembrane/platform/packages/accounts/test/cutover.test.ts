import { expect, test } from "bun:test";
import { deliverSamMessage, MemorySamQueue, type SamEnvelope } from "@dembrane/webhooks";
import { runDeliverEvent, runNotifySlack } from "../src/jobs";
import { silent } from "./helpers";

// An account event queued for ACCOUNTS_EVENTS_URL before sam's inbox was switched on.
const legacy = {
  payload: {
    id: "ev-1",
    timestamp: "2026-10-02T09:00:00.000Z",
    event: "account.document.signed",
    org: { id: "o1", name: "Gemeente Testdorp" },
  },
};

const neverDeliver = async () => {
  throw new Error("must not reach the legacy receiver");
};

test("a legacy queued event drains through the inbox under its timeline id once it is on", async () => {
  const inbox = new MemorySamQueue();
  await runDeliverEvent(
    { deliver: neverDeliver, url: "https://old.example", secret: null, logger: silent, inbox },
    legacy,
  );
  expect(inbox.of<SamEnvelope>(deliverSamMessage.name)).toEqual([
    {
      code: "echo_account_document_signed_v1",
      id: "ev-1",
      body: JSON.stringify({ code: "echo_account_document_signed_v1", json: legacy.payload }),
    },
  ]);
});

test("a legacy queued event with no receiver left fails instead of succeeding unsent", async () => {
  await expect(
    runDeliverEvent({ deliver: neverDeliver, url: null, secret: null, logger: silent }, legacy),
  ).rejects.toThrow("neither SAM_INBOX_URL nor ACCOUNTS_EVENTS_URL");
});

test("a queued Slack line with its webhook removed fails, unless sam's inbox now posts it", async () => {
  const post = async () => 200;
  await expect(runNotifySlack({ post, url: null }, { text: "x" })).rejects.toThrow(
    "ACCOUNTS_SLACK_WEBHOOK_URL",
  );
  await runNotifySlack({ post, url: null, samInbox: true, logger: silent }, { text: "x" });
});
