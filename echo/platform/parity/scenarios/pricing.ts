import { scenarios } from "../runner/scenario";

const P = "/api/v2/pricing-configurations";
const full = {
  config_session_id: " sess-1 ",
  question_set_version: "v3",
  config_shape_version: 2,
  mount: "app",
  locale: "en-US",
  wall_key: " ",
  workspace_id: "ws",
  answers_raw: {
    use_case: "something_else",
    use_case_other: "a   town\\nhall",
    volume: "under_50",
    concurrency: "more_than_40",
    concurrency_exact: "55",
  },
  config: {
    volume: "under_50",
    concurrency: "more_than_40",
    concurrency_exact: 55,
    answered: 4,
    furthest_step: 3,
    booking: { uid: "old" },
  },
  status: "in_progress",
};

// References are random (DEM-XXXX), so they are ignored; everything else must match.
export default scenarios([
  {
    name: "pricing: alice starts a configuration",
    as: "alice",
    method: "POST",
    path: P,
    body: full,
    ignoreFields: ["reference"],
  },
  {
    name: "pricing: a booking submits and records the booking",
    as: "erin",
    method: "POST",
    path: P,
    body: {
      ...full,
      booking_uid: " bk-1 ",
      booking_status: "ACCEPTED",
      booking_start: "2026-10-01T09:00:00Z",
    },
    ignoreFields: ["reference"],
  },
  {
    name: "pricing: minimal body takes defaults",
    as: "admin",
    method: "POST",
    path: P,
    body: { config_session_id: "s" },
    ignoreFields: ["reference"],
  },
  {
    name: "pricing: validation errors carry no body prefix",
    as: "alice",
    method: "POST",
    path: P,
    body: {
      config_session_id: "",
      mount: "x",
      answers_raw: [],
      status: "done",
      config_shape_version: "x",
    },
  },
  { name: "pricing: missing session id", as: "alice", method: "POST", path: P, body: {} },
  { name: "pricing: body must be an object", as: "alice", method: "POST", path: P, body: [1] },
  { name: "pricing: no body", as: "alice", method: "POST", path: P },
  { name: "pricing: anonymous", as: "anonymous", method: "POST", path: P, body: full },
  {
    name: "pricing site: closed without a token",
    as: "anonymous",
    method: "POST",
    path: `${P}/site`,
    body: full,
  },
]);
