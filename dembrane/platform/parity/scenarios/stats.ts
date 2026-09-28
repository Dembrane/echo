import { scenarios } from "../runner/scenario";

// OPTIONS cannot be expressed by the runner; see packages/stats for the preflight note.
export default scenarios([
  { name: "stats: public numbers", as: "anonymous", method: "GET", path: "/api/stats/" },
]);
