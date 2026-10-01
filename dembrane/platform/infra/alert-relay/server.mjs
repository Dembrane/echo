// Posts Cloud Monitoring incidents to Slack. Monitoring publishes each incident to a Pub/Sub
// topic; a push subscription delivers it here. One message when an incident opens, a reply
// in its thread when it closes. The thread's ts is kept per incident as a small object in
// this environment's relay bucket, so a close finds its open message after any restart.
//
// Runs apart from the platform API and depends on none of its code or data, so an API or
// database outage still reaches Slack. No dependencies: Node's fetch and the metadata server.
import { createServer } from "node:http";

const { SLACK_BOT_TOKEN, SLACK_CHANNEL, STATE_BUCKET, ENV_NAME, PORT = "8080" } = process.env;
for (const [k, v] of Object.entries({ SLACK_BOT_TOKEN, SLACK_CHANNEL, STATE_BUCKET, ENV_NAME }))
  if (!v) throw new Error(`${k} is required`);

async function googleToken() {
  const r = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!r.ok) throw new Error(`metadata token: ${r.status}`);
  return (await r.json()).access_token;
}

const objectName = (id) => encodeURIComponent(`incidents/${id}.json`);

async function readThread(id) {
  const r = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o/${objectName(id)}?alt=media`,
    { headers: { authorization: `Bearer ${await googleToken()}` } },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`read thread: ${r.status}`);
  return (await r.json()).ts ?? null;
}

async function saveThread(id, ts) {
  const r = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${STATE_BUCKET}/o?uploadType=media&name=${objectName(id)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await googleToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ts }),
    },
  );
  if (!r.ok) throw new Error(`save thread: ${r.status}`);
}

async function slack(body) {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL, unfurl_links: false, ...body }),
  });
  const out = await r.json();
  if (!out.ok) throw new Error(`slack: ${out.error}`);
  return out.ts;
}

function resourceOf(i) {
  if (i.resource_display_name) return i.resource_display_name;
  const labels = i.resource?.labels ?? {};
  const name = labels.service_name ?? labels.worker_pool_name ?? labels.host ?? labels.database_id;
  return [i.resource?.type ?? i.resource_type_display_name, name].filter(Boolean).join(" ");
}

async function handle(incident) {
  const id = incident.incident_id;
  const state = incident.state === "closed" ? "closed" : "open";
  const summary = incident.summary ?? incident.condition_name ?? "";
  if (state === "open") {
    const text =
      `:rotating_light: *${ENV_NAME}* · ${incident.policy_name} · open\n` +
      `${summary}\n` +
      `Resource: ${resourceOf(incident) || "unknown"} · <${incident.url}|incident>`;
    const ts = await slack({ text });
    if (id) await saveThread(id, ts);
    return;
  }
  const ts = id ? await readThread(id) : null;
  const text = `:white_check_mark: *${ENV_NAME}* · ${incident.policy_name} · closed\n${summary}`;
  await slack(ts ? { text, thread_ts: ts } : { text: `${text}\n<${incident.url}|incident>` });
}

createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(req.url === "/health" ? 200 : 405).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const push = JSON.parse(raw);
    const payload = JSON.parse(Buffer.from(push.message?.data ?? "", "base64").toString("utf8"));
    if (!payload.incident) throw new Error("no incident in the message");
    await handle(payload.incident);
    res.writeHead(204).end();
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ severity: "ERROR", message: `relay failed: ${err.message}` })}\n`,
    );
    // 500 makes Pub/Sub retry; a message that can never parse is dropped with 204.
    res.writeHead(err instanceof SyntaxError ? 204 : 500).end();
  }
}).listen(Number(PORT));
