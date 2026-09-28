// A host creating, renaming and deleting a project: the write path through validation,
// access, the database and (on the old stack) Directus.

import { check } from "k6";
import http from "k6/http";

const BASE = __ENV.BASE_URL;
const WORKSPACE = "c0000000-0000-4000-8000-000000000001";

export const options = {
  scenarios: {
    writes: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 10),
      duration: __ENV.DURATION || "60s",
    },
  },
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

export function setup() {
  return { token: __ENV.TOKEN };
}

export default function (data) {
  const h = {
    headers: { authorization: `Bearer ${data.token}`, "content-type": "application/json" },
  };
  const created = http.post(
    `${BASE}/api/v2/workspaces/${WORKSPACE}/projects`,
    JSON.stringify({ name: `load ${__VU}-${__ITER}` }),
    h,
  );
  if (!check(created, { created: (r) => r.status === 200 || r.status === 201 })) return;
  const id = created.json("id");
  check(
    http.patch(
      `${BASE}/api/v2/bff/projects/${id}`,
      JSON.stringify({ name: `load ${__VU}-${__ITER} renamed` }),
      h,
    ),
    {
      renamed: (r) => r.status === 200,
    },
  );
  check(http.del(`${BASE}/api/v2/bff/projects/${id}`, null, h), {
    deleted: (r) => r.status === 200 || r.status === 204,
  });
}
