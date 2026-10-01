import { scenarios } from "../runner/scenario";

export default scenarios([
  { name: "me: alice reads her profile", as: "alice", method: "GET", path: "/api/v2/me" },
  { name: "me: rita (read-only) reads her profile", as: "rita", method: "GET", path: "/api/v2/me" },
  { name: "me: staff admin reads their profile", as: "admin", method: "GET", path: "/api/v2/me" },
  { name: "me: anonymous is refused", as: "anonymous", method: "GET", path: "/api/v2/me" },
]);
