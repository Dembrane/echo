import { MEMORIES, agenticExtra as x } from "../chat-agentic-setup";
import { projects, workspaces } from "../fixtures";
import { P2_OPEN } from "../projects-setup";
import { scenarios } from "../runner/scenario";

const M = "/api/v2/bff/memory";
const MISSING = "f8000000-0000-4000-8000-000000000999";

export default scenarios([
  {
    name: "memory bff user: own",
    as: "alice",
    method: "GET",
    path: `${M}/user`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff user: none",
    as: "erin",
    method: "GET",
    path: `${M}/user`,
    setup: [MEMORIES],
  },
  { name: "memory bff user: anonymous", as: "anonymous", method: "GET", path: `${M}/user` },
  {
    name: "memory bff project: member",
    as: "alice",
    method: "GET",
    path: `${M}/project/${projects.p1}`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff project: other tenant",
    as: "bob",
    method: "GET",
    path: `${M}/project/${projects.p1}`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff project: observer refused",
    as: "rita",
    method: "GET",
    path: `${M}/project/${projects.p2}`,
    setup: [MEMORIES, P2_OPEN],
  },
  {
    name: "memory bff project: not onboarded",
    as: "dave",
    method: "GET",
    path: `${M}/project/${projects.legacy}`,
  },
  {
    name: "memory bff workspace: member",
    as: "alice",
    method: "GET",
    path: `${M}/workspace/${workspaces.aDefault}`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff workspace: observer refused",
    as: "rita",
    method: "GET",
    path: `${M}/workspace/${workspaces.aResearch}`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff workspace: no role",
    as: "bob",
    method: "GET",
    path: `${M}/workspace/${workspaces.aDefault}`,
  },
  {
    name: "memory bff workspace: missing",
    as: "alice",
    method: "GET",
    path: `${M}/workspace/${MISSING}`,
  },
  {
    name: "memory bff delete: own user memory",
    as: "alice",
    method: "DELETE",
    path: `${M}/${x.memUserAlice}`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff delete: someone's user memory",
    as: "alice",
    method: "DELETE",
    path: `${M}/${x.memUserBob}`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff delete: project memory",
    as: "alice",
    method: "DELETE",
    path: `${M}/${x.memProjectP1}`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff delete: workspace memory",
    as: "erin",
    method: "DELETE",
    path: `${M}/${x.memWorkspaceA}`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff delete: workspace memory, observer",
    as: "rita",
    method: "DELETE",
    path: `${M}/${x.memWorkspaceResearch}`,
    setup: [MEMORIES],
  },
  {
    name: "memory bff delete: no owner",
    as: "alice",
    method: "DELETE",
    path: `${M}/${x.memBroken}`,
    setup: [MEMORIES],
  },
  { name: "memory bff delete: missing", as: "alice", method: "DELETE", path: `${M}/${MISSING}` },
]);
