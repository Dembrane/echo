import { Toasty } from "@cloudflare/kumo";
import { createRoot } from "react-dom/client";
import { HostConfigPage } from "./pages/HostConfigPage";
import { ProjectHome } from "./pages/ProjectHome";
import { Start } from "./pages/Start";
import { Shell } from "./ui";
import "./styles.css";

const PAGES = new Set(["start", "host"]);

/**
 * No router library: the pathname picks the page. The portal's URLs are
 * /:language?/:projectId/:page?, with these pages:
 *   (none)  hosts choose between taking part and managing; anyone else goes to start
 *   start   the participant portal
 *   host    the project's settings
 */
function App() {
  const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const page = PAGES.has(parts.at(-1) ?? "") ? parts.pop() : undefined;
  const projectId = parts.length === 1 || parts.length === 2 ? parts.at(-1) : undefined;

  if (projectId) {
    const base = `/${parts.map(encodeURIComponent).join("/")}`;
    if (page === "start") return <Start />;
    if (page === "host") return <HostConfigPage projectId={projectId} />;
    return <ProjectHome projectId={projectId} base={base} />;
  }
  return (
    <Shell title="Not found">
      <p className="text-kumo-subtle text-sm">
        Open a project at <code>/:language/:projectId</code>.
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
