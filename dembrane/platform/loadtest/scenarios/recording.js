// Participants recording at once, each doing what the portal does
// (frontend/src/components/participant): load the project, initiate a conversation, open
// the health stream, ping every 3 s, and every 30 s (useChunkedAudioRecorder's timeslice)
// ask for an upload URL, POST a real 30 s chunk to the bucket and confirm it. The
// conversation and its chunks are refetched every 60 s as the portal's queries do. After
// SESSION the participant finishes. Each VU is one participant; starts are spread over the
// first 30 s so chunk uploads do not arrive in lockstep.
//   VUS participants, SESSION (default 5m), STREAM=0 skips the health stream,
//   PROJECT the open project, AUDIO the chunk file mounted into the container.

import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import { clearInterval, setInterval, setTimeout } from "k6/timers";

const BASE = `${__ENV.BASE_URL}/api`;
const PROJECT = __ENV.PROJECT || "f0000000-0000-4000-8000-000000000001";
const VUS = Number(__ENV.VUS || 25);
const STREAM = __ENV.STREAM !== "0";
const SESSION_S = parseDuration(__ENV.SESSION || "5m");
const STAGGER_S = 30;
const CHUNK_S = 30;
const PING_S = 3;
const POLL_S = 60;
const AUDIO = open(__ENV.AUDIO || "/f/chunk-30s.webm", "b");
const AUDIO_TYPE = "audio/webm";

export const options = {
  scenarios: {
    participants: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: `${SESSION_S + STAGGER_S + 180}s`,
    },
  },
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
  // The health stream is expected to end at its timeout; count it by our own metrics.
  discardResponseBodies: true,
};

const joinOk = new Rate("join_ok");
const joinMs = new Trend("join_ms", true);
const pingOk = new Rate("ping_ok");
const pingMs = new Trend("ping_ms", true);
const streamFailed = new Counter("stream_failed");
const streamOpened = new Counter("stream_opened");
const uploadUrlMs = new Trend("upload_url_ms", true);
const s3UploadMs = new Trend("s3_upload_ms", true);
const confirmMs = new Trend("confirm_ms", true);
const chunkOk = new Rate("chunk_ok");
const chunkMs = new Trend("chunk_total_ms", true);
const pollOk = new Rate("poll_ok");
const finishOk = new Rate("finish_ok");

function parseDuration(s) {
  const m = /^(\d+)(ms|s|m)?$/.exec(s);
  if (!m) throw new Error(`bad duration ${s}`);
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60 : m[2] === "ms" ? n / 1000 : n;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (r) => r.status >= 200 && r.status < 300;

// Presigned POST as the browser sends it: the policy fields first, the file last.
function multipart(fields, fileName) {
  const boundary = `----k6${Math.random().toString(16).slice(2)}`;
  let head = "";
  for (const [k, v] of Object.entries(fields))
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${AUDIO_TYPE}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = new Uint8Array(head.length + AUDIO.byteLength + tail.length);
  for (let i = 0; i < head.length; i++) body[i] = head.charCodeAt(i);
  body.set(new Uint8Array(AUDIO), head.length);
  for (let i = 0; i < tail.length; i++) body[head.length + AUDIO.byteLength + i] = tail.charCodeAt(i);
  return { body: body.buffer, type: `multipart/form-data; boundary=${boundary}` };
}

export default async function () {
  await wait(Math.random() * STAGGER_S * 1000);
  // A distinct client address per participant: both APIs rate-limit pings per
  // X-Forwarded-For, and a real crowd does not share one address.
  const ip = `10.${(__VU >> 16) & 255}.${(__VU >> 8) & 255}.${__VU & 255}`;
  const json = {
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  };
  const get = { headers: { "x-forwarded-for": ip } };

  const t0 = Date.now();
  const project = http.get(`${BASE}/participant/projects/${PROJECT}`, { ...get, tags: { name: "project" } });
  const init = ok(project)
    ? http.post(
        `${BASE}/participant/projects/${PROJECT}/conversations/initiate`,
        JSON.stringify({
          name: `load ${__VU}`,
          pin: "",
          source: "PORTAL_AUDIO",
          tag_id_list: [],
          user_agent: "k6 recording",
        }),
        { ...json, tags: { name: "initiate" }, responseType: "text" },
      )
    : project;
  joinMs.add(Date.now() - t0);
  const joined = ok(init);
  joinOk.add(joined);
  if (!joined) return;
  const cid = init.json("id");

  const sessionEnd = Date.now() + SESSION_S * 1000;
  const timers = [];

  if (STREAM) {
    streamOpened.add(1);
    http
      .asyncRequest("GET", `${BASE}/conversations/health/stream?conversation_ids=${cid}`, null, {
        ...get,
        tags: { name: "health_stream" },
        timeout: `${SESSION_S * 1000}ms`,
        responseCallback: http.expectedStatuses(0, 200),
      })
      .then((r) => {
        // Ending at our own timeout is the stream living the whole session; anything
        // earlier (refused, dropped, an error status) is a stream failure.
        if (r.status !== 200 && r.error_code === 1050) return;
        if (Date.now() < sessionEnd - 2000 || r.status !== 200) streamFailed.add(1);
      });
  }

  const ping = () => {
    const sent = Date.now();
    http
      .asyncRequest(
        "POST",
        `${BASE}/participant/conversations/${cid}/ping`,
        JSON.stringify({
          client_ts: sent,
          project_id: PROJECT,
          state: "recording",
          mode: "voice",
          audio_level: Math.round(Math.random() * 100) / 100,
          recorded_seconds: Math.round((sent - (sessionEnd - SESSION_S * 1000)) / 100) / 10,
          network: { online: true, effective_type: "4g", downlink: 10, rtt: 50 },
        }),
        { ...json, tags: { name: "ping" } },
      )
      .then((r) => {
        pingOk.add(ok(r));
        pingMs.add(r.timings.duration);
      });
  };
  ping();
  timers.push(setInterval(ping, PING_S * 1000));

  let n = 0;
  const upload = async () => {
    const started = Date.now();
    const timestamp = new Date(started).toISOString();
    const fileName = `chunk-${started}-${n++}.webm`;
    const url = await http.asyncRequest(
      "POST",
      `${BASE}/participant/conversations/${cid}/get-upload-url`,
      JSON.stringify({ content_type: AUDIO_TYPE, conversation_id: cid, filename: fileName }),
      { ...json, tags: { name: "upload_url" }, responseType: "text" },
    );
    uploadUrlMs.add(url.timings.duration);
    if (!ok(url)) return chunkOk.add(false);
    const { chunk_id, upload_url, fields, file_url } = url.json();
    const form = multipart(fields, fileName);
    const put = await http.asyncRequest("POST", upload_url, form.body, {
      headers: { "content-type": form.type },
      tags: { name: "s3_upload" },
      timeout: "300s",
    });
    s3UploadMs.add(put.timings.duration);
    if (!ok(put)) return chunkOk.add(false);
    const confirm = await http.asyncRequest(
      "POST",
      `${BASE}/participant/conversations/${cid}/confirm-upload`,
      JSON.stringify({ chunk_id, file_url, source: "PORTAL_AUDIO", timestamp }),
      { ...json, tags: { name: "confirm" } },
    );
    confirmMs.add(confirm.timings.duration);
    chunkOk.add(ok(confirm));
    chunkMs.add(Date.now() - started);
  };
  const pending = [];
  timers.push(setInterval(() => pending.push(upload()), CHUNK_S * 1000));

  const poll = () => {
    for (const [name, path] of [
      ["conversation", `participant/projects/${PROJECT}/conversations/${cid}`],
      ["chunks", `participant/projects/${PROJECT}/conversations/${cid}/chunks`],
    ])
      http.asyncRequest("GET", `${BASE}/${path}`, null, { ...get, tags: { name } }).then((r) => pollOk.add(ok(r)));
  };
  timers.push(setInterval(poll, POLL_S * 1000));

  await wait(sessionEnd - Date.now());
  for (const t of timers) clearInterval(t);
  // The recorder stops: the last partial chunk goes up, then the conversation finishes.
  await upload();
  await Promise.all(pending);
  const fin = await http.asyncRequest("POST", `${BASE}/participant/conversations/${cid}/finish`, null, {
    ...get,
    tags: { name: "finish" },
  });
  finishOk.add(ok(fin));
}
