// Fixed identities of the parity seed. Scenarios import these instead of looking rows up,
// so a scenario file reads the same against every template rebuild.

const id = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

export const users = {
  // Directus Administrator (admin_access); has an app_user so /v2/me works.
  admin: {
    directus: id("d0", 1),
    app: id("a0", 1),
    email: "parity-admin@example.com",
    role: "Administrator",
    first: "Parity",
    last: "Admin",
  },
  // Basic User; owner of org A.
  alice: {
    directus: id("d0", 2),
    app: id("a0", 2),
    email: "alice.parity@example.com",
    role: "Basic User",
    first: "Alice",
    last: "Owner",
  },
  // Basic User; owner of org B, external collaborator in org A's research workspace.
  bob: {
    directus: id("d0", 3),
    app: id("a0", 3),
    email: "bob.parity@example.com",
    role: "Basic User",
    first: "Bob",
    last: "Other",
  },
  // Enterprise User; admin of org A.
  erin: {
    directus: id("d0", 4),
    app: id("a0", 4),
    email: "erin.parity@example.com",
    role: "Enterprise User",
    first: "Erin",
    last: "Enterprise",
  },
  // Read-Only; observer (no org membership) in org A's research workspace.
  rita: {
    directus: id("d0", 5),
    app: id("a0", 5),
    email: "rita.parity@example.com",
    role: "Read-Only",
    first: "Rita",
    last: "Readonly",
  },
  // Basic User who never onboarded: owns a legacy project with no workspace, no app_user.
  dave: {
    directus: id("d0", 6),
    app: null,
    email: "dave.parity@example.com",
    role: "Basic User",
    first: "Dave",
    last: "Legacy",
  },
} as const;

export const orgs = { a: id("b0", 1), b: id("b0", 2) } as const;
export const billing = { a: id("ba", 1), b: id("ba", 2) } as const;
export const workspaces = {
  aDefault: id("c0", 1),
  aResearch: id("c0", 2),
  bDefault: id("c0", 3),
} as const;
export const projects = {
  p1: id("f0", 1),
  p2: id("f0", 2),
  p3: id("f0", 3),
  legacy: id("f0", 4),
} as const;
export const conversations = { c1: id("c1", 1), c2: id("c1", 2), c3: id("c1", 3) } as const;
export const chats = { p1: id("c3", 1) } as const;
export const webhooks = { p1: id("f1", 1) } as const;
export const tags = { p1Energy: id("f2", 1), p1Mobility: id("f2", 2) } as const;
export const verificationTopicKey = "parity-local-priorities";
export const agent = {
  client: id("ac", 1),
  grant: id("ad", 1),
  access: id("ae", 1),
  refresh: id("ae", 2),
  pair: id("af", 1),
} as const;
export { id };
