import { Toasty } from "@cloudflare/kumo";
import { createRoot } from "react-dom/client";
import { HostConfigPage } from "./HostConfigPage";
import { Shell } from "./ui";
import "./styles.css";

/**
 * No router library: the pathname picks the page. The portal's URLs are
 * /:language?/:projectId/..., so the host's page is /:language?/:projectId/host.
 */
function App() {
  const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const isHost = parts.at(-1) === "host" && (parts.length === 2 || parts.length === 3);
  const projectId = isHost ? parts.at(-2) : undefined;

  if (projectId) return <HostConfigPage projectId={projectId} />;
  return (
    <Shell title="Not found">
      <p className="text-kumo-subtle text-sm">
        Open a project's settings at <code>/:language/:projectId/host</code>.
      </p>
    </Shell>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <Toasty>
      <App />
    </Toasty>,
  );
