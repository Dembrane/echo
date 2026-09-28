// A host opening the dashboard: profile, workspaces, projects in a workspace, one project.
// The same requests against either stack; the token comes from setup().

import { check } from "k6";
import http from "k6/http";

const BASE = __ENV.BASE_URL;
const WORKSPACE = "c0000000-0000-4000-8000-000000000001";
const PROJECT = "f0000000-0000-4000-8000-000000000001";

export const options = {
  scenarios: {
    dashboard: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 50),
      duration: __ENV.DURATION || "60s",
    },
  },
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

export function setup() {
  return { token: __ENV.TOKEN };
}

export default function (data) {
  const h = { headers: { authorization: `Bearer ${data.token}` } };
  const res = http.batch([
    ["GET", `${BASE}/api/v2/me`, null, h],
    ["GET", `${BASE}/api/v2/workspaces`, null, h],
    ["GET", `${BASE}/api/v2/workspaces/${WORKSPACE}/projects`, null, h],
    ["GET", `${BASE}/api/v2/projects/${PROJECT}`, null, h],
  ]);
  for (const r of res) check(r, { "status 200": (x) => x.status === 200 });
}
