// The dashboard's accounts, shared by the dashboard and its login page: kept
// in browser storage, and logged in to Directus the way the iOS app does.

// `accounts` holds every Directus login in the account switcher, each
// { url, accessToken, refreshToken, id, email }; `current` is the id of the
// one in use.
const load = (key) => { try { return JSON.parse(localStorage.getItem("dashboard:" + key)); } catch { return null; } };
const save = (key, value) => {
  try {
    if (value == null) localStorage.removeItem("dashboard:" + key);
    else localStorage.setItem("dashboard:" + key, JSON.stringify(value));
  } catch {}
};

export const accounts = () => load("accounts") ?? [];
export const currentAccount = () => accounts().find((a) => a.id === load("current")) ?? null;
export const setCurrent = (id) => save("current", id);

// Add an account, or replace the saved one for the same user.
function saveAccount(account) {
  save("accounts", [...accounts().filter((a) => a.id !== account.id), account]);
}

export function removeAccount(id) {
  save("accounts", accounts().filter((a) => a.id !== id));
  if (load("current") === id) save("current", null);
}

export const claimsOf = (token) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
export const secondsLeft = (claims) => claims.exp - Math.floor(Date.now() / 1000);

// Only paths on this host, so a ?next= can't bounce people somewhere else.
export const safePath = (path, fallback) => (path && path.startsWith("/") && !path.startsWith("//") ? path : fallback);

export const loginUrl = (next) => `/dembrane-dashboard/login?next=${encodeURIComponent(next)}`;

async function directus(base, path, { body, token } = {}) {
  const res = await fetch(base.replace(/\/$/, "") + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body && { "content-type": "application/json" }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.errors?.[0]?.message ?? `HTTP ${res.status}`);
  return json.data;
}

export async function loginToDirectus(url, email, password, otp) {
  const auth = await directus(url, "/auth/login", {
    body: { email, password, ...(otp && { otp }), mode: "json" },
  });
  const me = await directus(url, "/users/me?fields=id,email", { token: auth.access_token });
  const account = { url, accessToken: auth.access_token, refreshToken: auth.refresh_token, id: me.id, email: me.email };
  saveAccount(account);
  setCurrent(account.id);
  return account;
}

export async function refreshDirectus(account) {
  const auth = await directus(account.url, "/auth/refresh", {
    body: { refresh_token: account.refreshToken, mode: "json" },
  });
  const refreshed = { ...account, accessToken: auth.access_token, refreshToken: auth.refresh_token };
  saveAccount(refreshed);
  return refreshed;
}
