import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Input,
  InputArea,
  LayerCard,
  Loader,
  Select,
  Switch,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import { ArrowSquareOutIcon, SignInIcon, WarningIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Config,
  type ConfigView,
  FIELDS,
  type FieldDef,
  GROUPS,
  type GroupKey,
} from "../../shared/fields";
import {
  errorMessage,
  fieldErrors,
  getAccess,
  getAppConfig,
  getConfig,
  getSession,
  saveConfig,
} from "../api";
import { ProjectNotFound, Shell } from "../ui";

type State =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "missing" }
  | { kind: "failed"; message: string; forbidden: boolean }
  | { kind: "ready"; view: ConfigView };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const jsonText = (value: unknown) => (value == null ? "" : JSON.stringify(value, null, 2));

const jsonTexts = (config: Config) =>
  Object.fromEntries(
    FIELDS.filter((f) => f.kind === "json").map((f) => [f.key, jsonText(config[f.key])]),
  );

/** `next`, except fields edited since `sent` was sent, which keep their edit. */
function keepEdits<T extends Record<string, unknown>>(next: T, sent: T, current: T): T {
  const out: Record<string, unknown> = { ...next };
  for (const k of Object.keys(current)) if (!same(current[k], sent[k])) out[k] = current[k];
  return out as T;
}

// Whether auto-sync was on, remembered per browser.
const AUTO_SYNC_KEY = "autoSync";
function readAutoSync() {
  try {
    return localStorage.getItem(AUTO_SYNC_KEY) === "true";
  } catch {
    return false;
  }
}

/** The settings form for one project, read from and saved to its mirror. */
export function HostConfigPage({ projectId, base }: { projectId: string; base: string }) {
  const toasts = useKumoToastManager();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [email, setEmail] = useState<string | null>(null);
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<Config>({});
  // JSON fields are edited as text, and parsed when saved.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoSync, setAutoSync] = useState(readAutoSync);
  // Focus left a field with changes waiting: auto-sync saves now.
  const [leftField, setLeftField] = useState(false);

  const show = useCallback((view: ConfigView) => {
    setState({ kind: "ready", view });
    setDraft(view.config);
    setDrafts(jsonTexts(view.config));
  }, []);

  function toggleAutoSync(on: boolean) {
    setAutoSync(on);
    try {
      localStorage.setItem(AUTO_SYNC_KEY, String(on));
    } catch {
      // Private windows can refuse storage; the choice then lasts for this visit.
    }
  }

  useEffect(() => {
    (async () => {
      const [app, session, access] = await Promise.all([
        getAppConfig(),
        getSession(),
        getAccess(projectId),
      ]);
      if (app.ok) setDashboardUrl(app.body.dashboardUrl);
      if (!access.ok && access.status === 404) return setState({ kind: "missing" });
      if (!session.ok || !session.body) return setState({ kind: "signed-out" });
      setEmail(session.body.user.email);

      const res = await getConfig(projectId);
      if (res.ok) return show(res.body);
      if (res.status === 401) return setState({ kind: "signed-out" });
      if (res.status === 404) return setState({ kind: "missing" });
      setState({
        kind: "failed",
        message: res.status === 403 ? "You don't have access to this project." : errorMessage(res),
        forbidden: res.status === 403,
      });
    })();
  }, [projectId, show]);

  const loaded = state.kind === "ready" ? state.view.config : {};

  /** The fields changed since loading, as the API takes them. */
  const changes = useMemo(() => {
    const out: Config = {};
    for (const f of FIELDS) {
      if (f.kind === "json") {
        if (drafts[f.key] !== jsonText(loaded[f.key])) out[f.key] = drafts[f.key];
      } else if (!same(draft[f.key], loaded[f.key])) {
        // An emptied text field clears the setting.
        out[f.key] = draft[f.key] === "" ? null : draft[f.key];
      }
    }
    return out;
  }, [draft, drafts, loaded]);
  const changed = Object.keys(changes);

  async function save({ quiet = false } = {}) {
    setErrors({});
    setSaveError(null);
    const sentDraft = draft;
    const sentDrafts = drafts;
    const fields: Config = { ...changes };
    for (const f of FIELDS) {
      if (f.kind !== "json" || !(f.key in fields)) continue;
      const text = (fields[f.key] as string).trim();
      try {
        fields[f.key] = text === "" ? null : JSON.parse(text);
      } catch {
        return setErrors({ [f.key]: "Not valid JSON" });
      }
    }

    setSaving(true);
    const res = await saveConfig(projectId, fields);
    setSaving(false);
    if (!res.ok) {
      if (res.status === 401) return setState({ kind: "signed-out" });
      return setSaveError(errorMessage(res));
    }
    // Edits made while the save was out stay, to go in the next one.
    setState({ kind: "ready", view: res.body });
    setDraft((current) => keepEdits(res.body.config, sentDraft, current));
    setDrafts((current) => keepEdits(jsonTexts(res.body.config), sentDrafts, current));
    const { rejected, pending } = res.body;
    if (rejected) {
      const byField = fieldErrors(rejected.error);
      setErrors(byField);
      if (!Object.keys(byField).length) setSaveError(errorMessage(rejected.error));
      toasts.add({ title: "Not saved", description: "The API refused it.", variant: "error" });
    } else if (quiet) {
      // Auto-sync saves on every pause; the badge shows how it went.
    } else if (pending.length) {
      toasts.add({
        title: "Saved here",
        description: "The API is unreachable. It's sent when you next open this page.",
        variant: "warning",
      });
    } else {
      toasts.add({ title: "Saved", variant: "success" });
    }
  }

  // With auto-sync on, changes save 1s after the last edit, or as soon as focus
  // leaves a field, whichever comes first. It holds off after a failed save until
  // the next edit, rather than retrying in a loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: save reads the same state these name.
  useEffect(() => {
    if (!changed.length) return setLeftField(false);
    if (!autoSync || saving || saveError) return;
    const timer = setTimeout(
      () => {
        setLeftField(false);
        save({ quiet: true });
      },
      leftField ? 0 : 1000,
    );
    return () => clearTimeout(timer);
  }, [autoSync, changes, saving, saveError, leftField]);

  const title =
    state.kind === "ready" ? String(draft.name ?? "Untitled project") : "Project settings";
  const dashboardLink = dashboardUrl && (
    <Button
      variant="ghost"
      size="sm"
      icon={<ArrowSquareOutIcon size={16} />}
      onClick={() => window.open(`${dashboardUrl}/projects/${projectId}/portal-editor`, "_blank")}
    >
      Dashboard
    </Button>
  );

  if (state.kind === "loading") {
    return (
      <Shell title={title}>
        <div className="flex justify-center py-12">
          <Loader size="lg" />
        </div>
      </Shell>
    );
  }
  if (state.kind === "missing") return <ProjectNotFound />;
  if (state.kind === "signed-out") {
    return (
      <Shell title={title}>
        <Banner
          icon={<SignInIcon />}
          title="Sign in on the dashboard"
          description="This page uses your dashboard session. Sign in there, then reload this page."
          action={
            <>
              {dashboardUrl && (
                <Banner.Action onClick={() => window.open(dashboardUrl, "_blank")}>
                  Open the dashboard
                </Banner.Action>
              )}
              <Banner.Action variant="secondary" onClick={() => location.assign(`${base}/start`)}>
                Back to the conversation
              </Banner.Action>
            </>
          }
        />
      </Shell>
    );
  }
  if (state.kind === "failed") {
    return (
      <Shell title={title} actions={dashboardLink}>
        <Banner
          variant="error"
          icon={<WarningIcon />}
          title="Can't open this project"
          description={state.message}
          action={
            state.forbidden && (
              <Banner.Action onClick={() => location.assign(`${base}/start`)}>
                Back to the conversation
              </Banner.Action>
            )
          }
        />
      </Shell>
    );
  }

  const { view } = state;
  const groups = Object.keys(GROUPS) as GroupKey[];

  return (
    <Shell title={title} actions={dashboardLink}>
      <div className="flex flex-wrap items-center gap-2">
        {email && (
          <Text variant="secondary" size="sm">
            {email}
          </Text>
        )}
        {view.role && <Badge variant="neutral">{view.role}</Badge>}
        {view.pending.length ? (
          <Badge variant="warning" appearance="dot">
            {view.pending.length} pending
          </Badge>
        ) : (
          <Badge variant="success" appearance="dot">
            Synced
          </Badge>
        )}
      </div>

      {saveError && (
        <Banner variant="error" icon={<WarningIcon />} title="Not saved" description={saveError} />
      )}

      {/* React's onBlur bubbles, as focusout does: it fires when any field loses focus.
          Saving is the buttons' or auto-sync's job, so Enter doesn't submit. */}
      <form
        className="flex flex-col gap-4"
        onBlur={() => setLeftField(true)}
        onSubmit={(e) => e.preventDefault()}
      >
        {groups.map((group) => (
          <LayerCard key={group}>
            <LayerCard.Secondary>{GROUPS[group]}</LayerCard.Secondary>
            <LayerCard.Primary className="flex flex-col gap-4">
              {FIELDS.filter((f) => f.group === group).map((f) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={f.kind === "json" ? drafts[f.key] : draft[f.key]}
                  pending={view.pending.includes(f.key)}
                  error={errors[f.key]}
                  onChange={(v) => {
                    setSaveError(null);
                    if (f.kind === "json") setDrafts((d) => ({ ...d, [f.key]: v as string }));
                    else setDraft((d) => ({ ...d, [f.key]: v }));
                  }}
                />
              ))}
            </LayerCard.Primary>
          </LayerCard>
        ))}
      </form>

      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 bg-kumo-base py-3">
        <Checkbox label="Auto-sync" checked={autoSync} onCheckedChange={toggleAutoSync} />
        <Text variant="secondary" size="sm">
          {saving
            ? "Saving…"
            : changed.length
              ? `${changed.length} changed`
              : autoSync
                ? "All changes saved"
                : "No changes"}
        </Text>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={autoSync || !changed.length || saving}
            onClick={() => show(view)}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            loading={saving && !autoSync}
            disabled={autoSync || !changed.length}
            onClick={() => save()}
          >
            Save
          </Button>
        </div>
      </div>
    </Shell>
  );
}

function FieldInput({
  field,
  value,
  pending,
  error,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  pending: boolean;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const label = pending ? (
    <span className="flex items-center gap-2">
      {field.label}
      <Badge variant="warning">pending</Badge>
    </span>
  ) : (
    field.label
  );

  switch (field.kind) {
    case "bool":
      return (
        <Switch
          label={label}
          checked={value === true}
          onClick={() => onChange(!(value === true))}
        />
      );
    case "select":
      return (
        <Select
          label={label}
          description={field.description}
          placeholder="Not set"
          value={(value as string | null) ?? null}
          onValueChange={(v) => onChange(v ?? null)}
          items={field.options ?? {}}
        />
      );
    case "longtext":
    case "json":
      return (
        <InputArea
          label={label}
          description={field.description}
          error={error}
          autoResize
          minRows={field.kind === "json" ? 4 : 2}
          maxRows={12}
          className={field.kind === "json" ? "font-mono" : undefined}
          value={(value as string | null) ?? ""}
          onValueChange={onChange}
        />
      );
    default:
      return (
        <Input
          label={label}
          description={field.description}
          error={error}
          value={(value as string | null) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
