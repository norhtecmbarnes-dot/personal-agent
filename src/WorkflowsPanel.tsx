import { useEffect, useRef, useState } from "react";
import { runAgenticBrowserWorkflow, type BrowserTask } from "./agentic-browser";
import { notifyTelegram } from "./notify";
import "./workflows.css";

type SavedWorkflow = {
  id: string;
  title: string;
  instructions: string;
  procedure?: string;
  domains: string;
  targetUrl?: string;
  approvedBrief?: string;
  permission: string;
  model: string;
  state:
    | "draft"
    | "active"
    | "running"
    | "paused"
    | "completed"
    | "blocked"
    | "cancelled";
  result?: string;
  updatedAt: string;
};
type SavedResponse = { workflows?: SavedWorkflow[]; error?: string };
type BrowserTab = { id: string; url: string; title: string };
type BrowserData = {
  loginRequired?: boolean;
  ok?: boolean;
  error?: string;
  running?: boolean;
  worker?: boolean;
  ollama?: boolean;
  modelCount?: number;
  url?: string;
  title?: string;
  text?: string;
  tabId?: string;
  activeTabId?: string;
  tabs?: BrowserTab[];
};
const workloadPath = "/workloads/consistent-character-producer.md";
const clarificationSystem =
  "You are Personal Agent preparing a focused browser workflow. Read the linked Markdown workload and user brief. Ask concise questions only about essential fields still unanswered in the conversation. Track each field explicitly as supplied, unspecified by user, or unresolved; do not repeat questions already answered or explicitly marked unspecified. Never invent names, ages, heights, backstory, props, appearance, personality, or any canon detail the user did not supply. Preserve supplied facts exactly. Optional ideas must be explicitly labeled PROPOSAL and excluded from canon until the user accepts them. When details are sufficient, provide a DRAFT character bible and five scene prompt directions, explicitly labeling every field not supplied by the user as UNSPECIFIED. The user, not you, decides whether it is ready. Do not browse, generate images, or claim external actions. Keep secrets out.";
async function api(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(
    `/__local-model/${path}`,
    body
      ? {
          signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  let data: Record<string, unknown>;
  try {
    if (!contentType.includes("application/json")) throw Error();
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const excerpt = raw.replace(/\s+/g, " ").slice(0, 160);
    throw Error(
      `Personal Agent API “${path}” returned non-JSON (HTTP ${response.status}, ${contentType || "unknown content type"}). ${excerpt ? `Response: ${excerpt}` : "Check the app server and route."}`,
    );
  }
  if (!response.ok)
    throw Error(
      typeof data.error === "string"
        ? data.error
        : `${path} failed (HTTP ${response.status}).`,
    );
  return data;
}
export default function WorkflowsPanel() {
  const clarificationAbort = useRef<AbortController | null>(null);
  const [clarificationSeconds, setClarificationSeconds] = useState(0);
  const [clarificationStatus, setClarificationStatus] = useState("");
  useEffect(() => () => clarificationAbort.current?.abort(), []);
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]),
    [selectedWorkflowId, setSelectedWorkflowId] = useState(""),
    [removing, setRemoving] = useState(false),
    [name, setName] = useState("Consistent Character Producer"),
    [instructions, setInstructions] = useState(""),
    [domains, setDomains] = useState("app.videoexpress.ai"),
    [target, setTarget] = useState("https://app.videoexpress.ai/"),
    [brief, setBrief] = useState(""),
    [followUp, setFollowUp] = useState(""),
    [model, setModel] = useState(() => {
      try {
        return localStorage.getItem("localpilot.activeOllamaModel") || "";
      } catch {
        return "";
      }
    }),
    [stateReady, setStateReady] = useState(false),
    [workerReady, setWorkerReady] = useState(false),
    [runtimeHealth, setRuntimeHealth] = useState<BrowserData>({}),
    [busy, setBusy] = useState(false),
    [runAbort, setRunAbort] = useState<AbortController | null>(null),
    [log, setLog] = useState(""),
    [approval, setApproval] = useState<BrowserTask | null>(null),
    [resolveApproval, setResolveApproval] = useState<
      ((v: boolean) => void) | null
    >(null),
    [page, setPage] = useState<BrowserData>({}),
    [tabs, setTabs] = useState<BrowserTab[]>([]),
    [activeTabId, setActiveTabId] = useState(""),
    [workload, setWorkload] = useState(""),
    [clarification, setClarification] = useState(""),
    [clarifying, setClarifying] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [approvedBrief, setApprovedBrief] = useState("");
  const [models, setModels] = useState<Array<{ name: string; cloud: boolean }>>(
      [],
    ),
    [modelChoice, setModelChoice] = useState(""),
    [sessionChecked, setSessionChecked] = useState(false),
    [cloudConsent, setCloudConsent] = useState(false);
  const refreshModels = async () => {
    try {
      const d = (await api("models")) as {
        models?: Array<{ name: string }>;
        cloudModels?: Array<{ name: string }>;
      };
      setModels([
        ...(d.models || []).map((m) => ({ ...m, cloud: false })),
        ...(d.cloudModels || []).map((m) => ({ ...m, cloud: true })),
      ]);
    } catch (e) {
      setLog(e instanceof Error ? e.message : "Ollama unavailable");
    }
  };
  const chooseModel = (value: string) => {
    setModel(value);
    setCloudConsent(false);
    try {
      localStorage.setItem("localpilot.activeOllamaModel", value);
    } catch {
      /* model still selected */
    }
  };
  const refresh = async () => {
    try {
      const [md, d] = await Promise.all([
        fetch(workloadPath).then((r) =>
          r.ok
            ? r.text()
            : Promise.reject(Error("Workload Markdown is unavailable.")),
        ),
        api("workflows") as Promise<SavedResponse>,
      ]);
      setWorkload(md);
      setInstructions(md);
      setWorkflows(d.workflows || []);
      setStateReady(true);
    } catch (e) {
      setLog(e instanceof Error ? e.message : "Could not load workflows");
    }
  };
  const isCloudModel = (name: string) =>
    /(?:^|:)cloud(?:$|[-])|[-:]cloud$/i.test(name.trim());
  useEffect(() => {
    void refresh();
    void refreshModels();
    const checkHealth = () =>
      void api("browser-health")
        .then((d: BrowserData) => {
          setRuntimeHealth(d);
          setWorkerReady(!!d.running);
        })
        .catch((e) => {
          setWorkerReady(false);
          setRuntimeHealth({
            error:
              e instanceof Error ? e.message : "Local runtime unavailable.",
          });
        });
    checkHealth();
    const timer = window.setInterval(checkHealth, 5000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!workerReady) return;
    const poll = () =>
      void api("browser", { action: "tabs" })
        .then((d: BrowserData) => setTabs(d.tabs || []))
        .catch(() => {});
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => window.clearInterval(timer);
  }, [workerReady]);
  const checkSession = async () => {
    try {
      const d = (await api("browser", {
        action: "inspect",
        tabId: activeTabId || page.tabId,
      })) as BrowserData;
      setPage(d);
      setTabs(d.tabs || []);
      setActiveTabId(d.tabId || "");
      const ready = !d.loginRequired && !!d.text?.trim();
      setSessionChecked(ready);
      setLog(
        ready
          ? "Application page is readable. Confirm visually that your account is signed in; Personal Agent does not read authentication cookies."
          : "Sign-in required. Complete sign-in in Chromium, then check again.",
      );
    } catch (e) {
      setSessionChecked(false);
      setLog(e instanceof Error ? e.message : "Session check failed.");
    }
  };
  const save = async (item: SavedWorkflow) => {
    const d = (await api("workflows", { workflow: item })) as SavedResponse;
    setWorkflows(d.workflows || []);
  };
  const selectWorkflow = (id: string) => {
    setSelectedWorkflowId(id);
    const item = workflows.find((w) => w.id === id);
    if (!item) {
      setInstructions(workload);
      setName("Consistent Character Producer");
      setDomains("app.videoexpress.ai");
      setTarget("https://app.videoexpress.ai/");
      setBrief("");
      setApprovedBrief("");
      setClarification("");
      setFollowUp("");
      setConfirmed(false);
      return;
    }
    setSessionChecked(false);
    setInstructions(item.procedure || workload);
    setName(item.title);
    setDomains(item.domains);
    setTarget(item.targetUrl || "");
    setApprovedBrief(item.approvedBrief || "");
    setBrief(item.approvedBrief || "");
    setClarification("");
    setFollowUp("");
    setConfirmed(!!item.approvedBrief);
    setLog("Selected saved workflow for editing and review.");
  };
  const removeSelected = async () => {
    const item = workflows.find((w) => w.id === selectedWorkflowId);
    if (!item) return;
    if (item.state === "running") {
      setLog("Pause the running workflow before removing it.");
      return;
    }
    if (
      !window.confirm(
        `Remove “${item.title}” and permanently delete its saved workflow data from this device? This cannot be undone.`,
      )
    )
      return;
    setRemoving(true);
    try {
      await api("workflows", { action: "delete", workflow: { id: item.id } });
      setWorkflows((current) => current.filter((w) => w.id !== item.id));
      selectWorkflow("");
      setLog(
        `Removed “${item.title}” and deleted its saved workflow record. The shared Markdown workload file was not deleted.`,
      );
    } catch (e) {
      setLog(e instanceof Error ? e.message : "Could not remove workflow.");
    } finally {
      setRemoving(false);
    }
  };
  const create = async () => {
    const title = name.trim(),
      text = (instructions || workload).trim();
    if (text.length > 100000) {
      setLog("Workflow Markdown must be at most 100,000 characters.");
      return;
    }
    if (!title || !text) {
      setLog("Add a workload name and procedure first.");
      return;
    }
    let normalizedTarget = "";
    if (target.trim()) {
      try {
        const parsed = new URL(target.trim());
        if (!["http:", "https:"].includes(parsed.protocol)) throw Error();
        normalizedTarget = parsed.href;
        const host = parsed.hostname.toLowerCase();
        if (
          domains.trim() &&
          !domains
            .split(/[\s,]+/)
            .map((x) => x.trim().toLowerCase())
            .includes(host)
        )
          throw Error(
            `Target hostname ${host} is not in your allowed-host list.`,
          );
      } catch (e) {
        setLog(
          e instanceof Error && e.message.startsWith("Target hostname")
            ? e.message
            : "Target URL must be a valid http(s) URL.",
        );
        return;
      }
    }
    const derivedHosts =
      domains.trim() ||
      (normalizedTarget ? new URL(normalizedTarget).hostname : "");
    if (!normalizedTarget) {
      setLog(
        "Enter the target web app URL before saving. A hostname alone is not enough to activate a workflow.",
      );
      return;
    }
    if (!derivedHosts) {
      setLog("Enter the target URL and hostname allowlist before saving.");
      return;
    }
    const existing =
      workflows.find((w) => w.id === selectedWorkflowId) ||
      workflows.find((w) => w.title === title);
    const item: SavedWorkflow = {
      id: existing?.id || crypto.randomUUID(),
      title,
      instructions: workloadPath,
      procedure: text,
      domains: derivedHosts,
      targetUrl: normalizedTarget || undefined,
      approvedBrief: confirmed
        ? approvedBrief
        : existing &&
            existing.domains === derivedHosts &&
            existing.targetUrl === normalizedTarget
          ? existing.approvedBrief
          : undefined,
      permission:
        "One-time approval for every fill/click, including generation; authentication, uploads, payments and destructive actions remain manual",
      model,
      state: "draft",
      updatedAt: new Date().toISOString(),
    };
    await save(item);
    setSelectedWorkflowId(item.id);
    setLog(
      "Saved this workload with its host allowlist and target URL. Activate it when ready.",
    );
  };
  const start = async () => {
    setBusy(true);
    setLog("Starting the Personal Agent browser worker and visible Chromium…");
    try {
      const d = (await api("browser-start", {})) as BrowserData;
      setWorkerReady(!!d.running);
      setRuntimeHealth((current) => ({
        ...current,
        worker: !!d.running,
        running: !!d.running,
        error: d.running
          ? ""
          : d.error || "Worker did not report Chromium running.",
      }));
      setLog(
        d.running
          ? "Personal Agent browser worker is running and visible isolated Chromium is open. This confirms the local browser only; Video Express must still be opened and signed in within that browser. Sign in directly in the visible window if prompted."
          : d.error ||
              "Personal Agent could not start Chromium. Check Playwright/Chromium installation and the runtime details above.",
      );
    } catch (e) {
      setWorkerReady(false);
      const message = e instanceof Error ? e.message : "Browser start failed";
      setRuntimeHealth((current) => ({
        ...current,
        worker: false,
        running: false,
        error: message,
      }));
      setLog(message);
    } finally {
      setBusy(false);
      setRunAbort(null);
    }
  };
  const open = async () => {
    setSessionChecked(false);
    setBusy(true);
    try {
      await api("browser-start", {});
      setWorkerReady(true);
      const u = new URL(target);
      if (!["http:", "https:"].includes(u.protocol))
        throw Error("Only http(s) URLs are allowed.");
      const host = u.hostname.toLowerCase();
      const listed = domains
        .split(/[\s,]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      if (listed.length && !listed.includes(host))
        throw Error(`Target hostname ${host} is not in your allowlist.`);
      await api("browser", { action: "allow-host", host });
      const d = (await api("browser", {
        action: "open-app",
        url: u.href,
      })) as BrowserData;
      setPage(d);
      setTabs(d.tabs || []);
      setActiveTabId(d.tabId || "");
      setLog(
        `Opened ${d.title || d.url} in tab ${d.tabId || "(unknown)"}\n${d.text || "(No visible page text returned.)"}\n\nSign in directly in the browser if required.`,
      );
    } catch (e) {
      setLog(e instanceof Error ? e.message : "Could not open target URL");
    } finally {
      setBusy(false);
    }
  };
  const askModel = async () => {
    const selected = (model || "").replace(/^Ollama · /, "");
    if (!selected) {
      setLog("No model is selected. Choose a model in step 1.");
      return;
    }
    if (isCloudModel(selected) && !cloudConsent) {
      setLog("Confirm cloud data sharing in step 1 before using this model.");
      return;
    }
    if (!workload) {
      setLog("Linked workload Markdown did not load.");
      return;
    }
    const controller = new AbortController();
    clarificationAbort.current = controller;
    setClarificationSeconds(0);
    setClarificationStatus("");
    const started = Date.now();
    const timer = window.setInterval(() => setClarificationSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    setClarifying(true);
    setConfirmed(false);
    try {
      const d = (await api("chat", {
        model: selected,
        purpose: "workflow-clarification",
        messages: [
          { role: "system", content: clarificationSystem },
          {
            role: "user",
            content: `WORKLOAD MARKDOWN:\n${instructions || workload}\n\nCONVERSATION SO FAR:\n${clarification || "(none)"}\n\nORIGINAL USER BRIEF:\n${brief || "(empty; ask essential questions)"}\n\nUSER FOLLOW-UP ANSWER:\n${followUp || "(no new answer)"}\n\nNever treat absent detail as fact. Read the full conversation and incorporate the latest user answer. Ask only unresolved essential questions not already answered or marked unspecified; do not repeat earlier questions. Otherwise present a DRAFT character bible and five scene prompt directions; explicitly label unsupported fields UNSPECIFIED. The user will edit and approve the canonical version.`,
          },
        ],
      }, controller.signal)) as { message?: string; elapsedMs?: number; truncated?: boolean };
      setClarificationStatus(d.truncated
        ? "Output limit reached: this draft is incomplete. Continue with the model before review."
        : `Local model replied in ${Math.round((d.elapsedMs || Date.now() - started) / 1000)}s. Draft only; approval is still required.`);
      setClarification((current) =>
        current
          ? `${current}\n\nUser: ${followUp || "(asked to continue)"}\n\nPersonal Agent: ${d.message || "No response."}`
          : d.message || "Local model returned no response.",
      );
      setFollowUp("");
      setLog(
        "Review the LLM response. Only you can confirm it as the brief; invented facts must be marked unspecified or removed.",
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        notifyTelegram(
          `Personal Agent: model error during clarification — ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
        );
      }
      setClarificationStatus(controller.signal.aborted ? "Clarification cancelled. Previous draft preserved; nothing approved." : e instanceof Error ? e.message : "Clarification failed.");
    } finally {
      window.clearInterval(timer);
      clarificationAbort.current = null;
      setClarifying(false);
    }
  };
  const run = async (item: SavedWorkflow) => {
    if (
      item.title.toLowerCase().includes("consistent character") &&
      !item.approvedBrief?.trim()
    ) {
      setLog(
        "Ask the model to clarify the brief, then confirm before browser actions.",
      );
      return;
    }
    if (!workerReady) {
      setLog("Start the isolated browser before running.");
      return;
    }
    const selected = (model || "").replace(/^Ollama · /, "");
    if (!selected) {
      setLog("No model is selected. Choose a model in step 1.");
      return;
    }
    if (isCloudModel(selected) && !cloudConsent) {
      setLog("Confirm cloud data sharing in step 1 before using this model.");
      return;
    }
    if (!sessionChecked) {
      setLog(
        "Open the application, sign in if needed, then Check session before running.",
      );
      return;
    }
    const hosts = item.domains
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!hosts.length) {
      setLog(
        "Add the target hostname to Allowed hostnames and save the workload.",
      );
      return;
    }
    const targetUrl = item.targetUrl || target.trim();
    if (!targetUrl) {
      setLog(
        "Set and save the target web app URL before activating this workflow.",
      );
      return;
    }
    try {
      const parsed = new URL(targetUrl);
      if (!hosts.includes(parsed.hostname.toLowerCase())) {
        setLog(
          "Saved target URL is not inside the saved host allowlist. Re-save the workload.",
        );
        return;
      }
    } catch {
      setLog("Saved target URL is invalid. Re-save the workload.");
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    setRunAbort(controller);
    const running = { ...item, state: "running" as const, result: undefined };
    try {
      await save(running);
      const linked = await fetch(
        item.instructions.startsWith("/") ? item.instructions : workloadPath,
      );
      if (!linked.ok)
        throw Error("Linked Markdown workload could not be loaded.");
      const liveInstructions = item.procedure || (await linked.text());
      const outcome = await runAgenticBrowserWorkflow({
        model: selected,
        workflow: liveInstructions,
        input: `USER-APPROVED BRIEF / DELIVERABLE:\n${item.approvedBrief || brief || "(Follow the saved workflow; request clarification if essential details are missing.)"}`,
        hosts,
        targetUrl,
        tabId: activeTabId || undefined,
        onEvidence: (d) => {
          setPage(d);
          setActiveTabId(d.tabId || "");
          if (d.tabs) setTabs(d.tabs);
        },
        signal: controller.signal,
        onLog: (message) => {
          setLog((current) => `${current}\n${message}`);
          const match = message.match(/tab (tab-\\d+)/);
          if (match) {
            setActiveTabId(match[1]);
            void api("browser", { action: "tabs" })
              .then((d: BrowserData) => setTabs(d.tabs || []))
              .catch(() => {});
          }
        },
        onApproval: (task) =>
          new Promise<boolean>((resolve) => {
            notifyTelegram(`Personal Agent: approval needed — ${task.detail || "a browser action awaits your approval"}`);
            setApproval(task);
            setResolveApproval(() => resolve);
          }),
      });
      const saved = {
        ...running,
        state: "paused" as const,
        result: outcome.summary,
      };
      await save(saved);
      notifyTelegram(
        `Personal Agent: workflow finished (paused for review) — ${outcome.summary.slice(0, 300)}`,
      );
      setPage((current) => ({ ...current, url: outcome.url }));
      setLog(
        (current) =>
          `${current}\n${outcome.summary}\nCurrent URL: ${outcome.url || "(unknown)"}`,
      );
    } catch (e) {
      const blocked = {
        ...running,
        state: controller.signal.aborted
          ? ("paused" as const)
          : ("blocked" as const),
        result: controller.signal.aborted
          ? "Paused by user."
          : e instanceof Error
            ? e.message
            : "Browser workflow failed.",
      };
      await save(blocked);
      notifyTelegram(
        controller.signal.aborted
          ? "Personal Agent: workflow paused by user."
          : `Personal Agent: workflow blocked/failed — ${blocked.result.slice(0, 300)}`,
      );
      setLog((current) => `${current}\nBLOCKED: ${blocked.result}`);
    } finally {
      setBusy(false);
      setRunAbort(null);
      setApproval(null);
      setResolveApproval(null);
    }
  };
  const resolve = (yes: boolean) => {
    resolveApproval?.(yes);
    setApproval(null);
    setResolveApproval(null);
    if (!yes)
      setLog((current) => `${current}\nPaused at your approval choice.`);
  };
  return (
    <main className="wf-page">
      <header className="wf-header">
        <div>
          <span className="wf-kicker">BROWSER WORKFLOW AUTOMATION</span>
          <h1>Workflows</h1>
          <p>
            Connect a model. Sign in once. Let your workflow guide the browser.
          </p>
        </div>
        <div className={`wf-status ${workerReady ? "ready" : ""}`}>
          {workerReady ? "Browser online" : "Browser offline"}
        </div>
      </header>
      <section className="wf-card">
        <h2>1 · Connect your model</h2>
        <p>
          Use a local model for on-device reasoning, or explicitly choose an
          Ollama cloud model.
        </p>
        <div className="wf-runtime-checks">
          <span>
            {runtimeHealth.ollama ? "Ollama connected" : "Ollama unavailable"}
          </span>
          <span>
            {workerReady
              ? "Persistent Chromium ready"
              : "Browser starts when you open the app"}
          </span>
        </div>
        <label>
          WORKFLOW MODEL
          <select value={model} onChange={(e) => chooseModel(e.target.value)}>
            <option value="">Choose an Ollama model</option>
            {model && !models.some((m) => m.name === model) && (
              <option value={model}>{model}</option>
            )}
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} · {m.cloud ? "cloud" : "local"}
              </option>
            ))}
          </select>
        </label>
        <div className="wf-actions">
          <button disabled={busy} onClick={() => void refreshModels()}>
            Refresh models
          </button>
        </div>
        <label>
          OTHER OLLAMA CLOUD MODEL
          <input
            value={modelChoice}
            onChange={(e) => setModelChoice(e.target.value)}
            placeholder="Exact model name ending in :cloud"
          />
        </label>
        <button
          disabled={!isCloudModel(modelChoice)}
          onClick={() => chooseModel(modelChoice.trim())}
        >
          Use cloud model
        </button>
        {isCloudModel(model) && (
          <label className="wf-consent">
            <input
              type="checkbox"
              checked={cloudConsent}
              onChange={(e) => setCloudConsent(e.target.checked)}
            />
            I allow my workflow, approved brief, and visible application text to
            be sent to this cloud model through my Ollama account. Charges or
            usage limits may apply.
          </label>
        )}
        <p className="wf-note">
          Ollama manages cloud sign-in and model access. No separate cloud API
          key is needed here. No silent cloud fallback.
        </p>
        {runtimeHealth.error && (
          <p className="wf-error">{runtimeHealth.error}</p>
        )}
      </section>
      <section className="wf-card">
        <h2>2 · Open the application and sign in</h2>
        <p>
          Video Express is the first test application. Sign in manually in
          Personal Agent’s Chromium window once. Its dedicated browser profile keeps
          cookies and website storage across restarts on this PC.
        </p>
        <label>
          APPLICATION URL
          <input
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setSessionChecked(false);
            }}
            placeholder="https://app.videoexpress.ai/"
          />
        </label>
        <label>
          ALLOWED HOSTNAMES
          <input
            value={domains}
            onChange={(e) => {
              setDomains(e.target.value);
              setSessionChecked(false);
            }}
          />
        </label>
        <div className="wf-actions">
          <button disabled={busy} onClick={() => void open()}>
            {busy ? "Working…" : "Open application / resume session"}
          </button>
          <button
            disabled={!workerReady || busy}
            onClick={() => void checkSession()}
          >
            Check session
          </button>
          <button disabled={busy} onClick={() => void start()}>
            Show browser
          </button>
        </div>
        <p role="status" className="wf-note">
          {sessionChecked
            ? "✓ Application readable · check your signed-in account in Chromium."
            : page.loginRequired
              ? "Sign-in required · complete it in Chromium, then Check session."
              : "Open the application, finish sign-in if requested, then Check session."}
        </p>
        <p className="wf-note">
          Sessions persist locally in .localpilot/browser-profile; they are not
          uploaded or deployed. Websites may expire sessions or require MFA
          again. Personal Agent never reads or fills passwords, OTPs, or
          authentication cookies.
        </p>
      </section>
      <section className="wf-card">
        <h2>3 · Prepare your workflow</h2>
        <div className="wf-toolbar">
          <a href={workloadPath} target="_blank" rel="noreferrer">
            Open Consistent Character Producer Markdown ↗
          </a>
          <span>Versioned workload file · editable in the project</span>
        </div>
        <label>
          WORKLOAD NAME
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          WORKFLOW MARKDOWN
          <textarea
            rows={8}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
              setConfirmed(false);
            }}
            placeholder="Paste your workflow instructions here"
          />
        </label>
        <label>
          IMPORT A MARKDOWN WORKFLOW
          <input
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 100000) {
                setLog("Workflow must be smaller than 100 KB.");
                return;
              }
              void file.text().then((text) => {
                setInstructions(text);
                setConfirmed(false);
                setLog(
                  "Workflow imported into the editor. Save workflow to keep it.",
                );
              });
            }}
          />
        </label>
        <label>
          TASK / CHARACTER BRIEF
          <textarea
            rows={4}
            value={brief}
            onChange={(e) => {
              setBrief(e.target.value);
              setConfirmed(false);
              setApprovedBrief("");
            }}
            placeholder="Character concept, identity traits, style, intended scenes…"
          />
        </label>
        <div className="wf-actions">
          <button onClick={() => void create()}>Save workload link</button>
        </div>
        <p className="wf-note">
          Authentication stays in the visible browser. The agent cannot read or
          fill passwords, OTPs, cookies, or tokens. Google may block sign-in in
          isolated Chromium; if so, use a supported regular browser or another
          permitted sign-in method—Personal Agent cannot override the provider’s
          security policy.
        </p>
      </section>
      <section className="wf-card">
        <header className="wf-subhead">
          <div>
            <h2>Workload assistant</h2>
            <p>
              It asks for missing essentials before the agent touches the web
              app.
            </p>
          </div>
        </header>
        <div className="wf-toolbar">
          <a href={workloadPath} target="_blank" rel="noreferrer">
            Read linked workload instructions ↗
          </a>
          <span>
            {model ? `Selected model: ${model}` : "Choose a model in step 1"}
          </span>
        </div>
        <label>
          FOLLOW-UP ANSWER
          <input
            value={followUp}
            onChange={(e) => {
              setFollowUp(e.target.value);
              setConfirmed(false);
            }}
            placeholder="Answer the model’s questions here…"
          />
        </label>
        <button disabled={clarifying} onClick={() => void askModel()}>
          {clarifying
            ? `Asking local model… ${clarificationSeconds}s`
            : clarification
              ? "Send answer / continue with model"
              : "Clarify my brief with the model"}
        </button>
        <>
          {clarifying && <p role="status">Local inference is running; cold loading and prompt processing can take time. Hidden reasoning is disabled for clarification. No browser actions are being performed.</p>}
          {clarifying && <button onClick={() => clarificationAbort.current?.abort()}>Cancel clarification</button>}
          {clarificationStatus && <p role="status">{clarificationStatus}</p>}
          {clarification && <pre className="wf-result">{clarification}</pre>}
          <div className="wf-actions">
            <button
              type="button"
              onClick={() => {
                setApprovedBrief(clarification || brief);
                setConfirmed(false);
                setLog(
                  "Model draft copied into the editor. Remove invented details and mark unknowns before approving.",
                );
              }}
            >
              Use model draft in editor
            </button>
          </div>
          <label>
            EDIT THE CANONICAL BRIEF BEFORE APPROVING
            <textarea
              rows={6}
              value={approvedBrief}
              onChange={(e) => {
                setApprovedBrief(e.target.value);
                setConfirmed(false);
              }}
              placeholder="Keep only facts you approve. Mark missing character traits as unspecified."
            />
          </label>
          <div className="wf-actions">
            <button
              disabled={!approvedBrief.trim()}
              onClick={async () => {
                if (!approvedBrief.trim()) {
                  setLog(
                    "Edit and approve the canonical brief before continuing.",
                  );
                  return;
                }
                const item = workflows.find((w) => w.id === selectedWorkflowId);
                if (!item || !item.targetUrl) {
                  setLog(
                    "Save the target workload first; confirmation must be tied to its saved target.",
                  );
                  return;
                }
                await save({
                  ...item,
                  procedure: instructions || workload,
                  approvedBrief: approvedBrief.trim(),
                  state: "draft",
                  updatedAt: new Date().toISOString(),
                });
                setConfirmed(true);
                setLog(
                  "Canonical brief approved and saved to this workflow. Activate it, then run in the isolated browser.",
                );
              }}
            >
              Confirm edited brief and continue
            </button>
            <button
              onClick={() => {
                setConfirmed(false);
                setClarification("");
                setApprovedBrief("");
                setLog(
                  "Brief reopened. Add details, then ask the selected model again.",
                );
              }}
            >
              Reset clarification
            </button>
          </div>
        </>
      </section>
      <section className="wf-card">
        <header className="wf-subhead">
          <div>
            <h2>Choose a workflow</h2>
            <p>Select a saved workflow to load its settings into the editor.</p>
          </div>
        </header>
        <label htmlFor="wf-select">
          SAVED WORKFLOWS
          <select
            id="wf-select"
            value={selectedWorkflowId}
            onChange={(e) => selectWorkflow(e.target.value)}
            disabled={!workflows.length}
          >
            <option value="">New workflow</option>
            {workflows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.state}
              </option>
            ))}
          </select>
        </label>
        <div className="wf-actions">
          <button
            className="danger"
            type="button"
            disabled={
              !selectedWorkflowId ||
              removing ||
              workflows.find((w) => w.id === selectedWorkflowId)?.state ===
                "running"
            }
            onClick={() => void removeSelected()}
          >
            {removing ? "Removing…" : "Remove selected workflow + saved data"}
          </button>
        </div>
        <p className="wf-note">
          Removal deletes the selected workflow record (including its saved
          brief, target, and result) from this device. It does not delete the
          shared Markdown workload file or other workflows.
        </p>
      </section>
      <section className="wf-card">
        <header className="wf-subhead">
          <div>
            <h2>4 · Run and review</h2>
            <p>
              {stateReady
                ? "Stored on this device. Activate only after clarifying."
                : "Loading saved workloads…"}
            </p>
          </div>
        </header>
        {workflows.length === 0 ? (
          <p>
            No workloads saved yet. Save the linked Markdown procedure to create
            one.
          </p>
        ) : (
          workflows.map((item) => (
            <article className="wf-item" key={item.id}>
              <div className="wf-item-head">
                <div>
                  <span className={`wf-badge ${item.state}`}>{item.state}</span>
                  <h3>{item.title}</h3>
                </div>
                <time>{new Date(item.updatedAt).toLocaleString()}</time>
              </div>
              <p>{item.domains || "No hostname allowlisted yet"}</p>
              <div className="wf-toolbar">
                <a href={workloadPath} target="_blank" rel="noreferrer">
                  Open linked Markdown ↗
                </a>
              </div>
              <div className="wf-item-actions">
                {item.state === "draft" && (
                  <button
                    disabled={!item.domains || !item.targetUrl}
                    title={
                      !item.domains || !item.targetUrl
                        ? "Save a target URL and hostname allowlist first"
                        : ""
                    }
                    onClick={() => void save({ ...item, state: "active" })}
                  >
                    Activate workload
                  </button>
                )}
                <button
                  disabled={busy || !activeTabId || item.state === "running"}
                  onClick={() => {
                    setBusy(true);
                    void api("discover-guides", { workflowId: item.id, tabId: activeTabId })
                      .then((result: { outcome?: { summary?: string } }) => setLog(result.outcome?.summary || "Guide discovery returned no findings."))
                      .catch((error: Error) => setLog(error.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Read workflow guides (read-only)
                </button>
                {item.state === "active" && (
                  <button
                    disabled={
                      busy ||
                      !sessionChecked ||
                      !model ||
                      (isCloudModel(model) && !cloudConsent) ||
                      (item.title
                        .toLowerCase()
                        .includes("consistent character") &&
                        !item.approvedBrief?.trim())
                    }
                    onClick={() => void run(item)}
                  >
                    Run agent in browser
                  </button>
                )}
                {item.state === "running" && (
                  <>
                    <span>Agent loop running…</span>
                    <button
                      onClick={() => {
                        runAbort?.abort();
                        setApproval(null);
                        resolveApproval?.(false);
                        setLog(
                          "Pause requested. The agent will stop before its next browser action.",
                        );
                      }}
                    >
                      Pause run
                    </button>
                  </>
                )}
                {item.state === "paused" && (
                  <button
                    onClick={() => void save({ ...item, state: "active" })}
                  >
                    Reactivate / run again
                  </button>
                )}
                {["blocked", "cancelled", "completed"].includes(item.state) && (
                  <button
                    onClick={() => void save({ ...item, state: "active" })}
                  >
                    Reactivate / run again
                  </button>
                )}
                {item.state === "active" && (
                  <button
                    onClick={() => void save({ ...item, state: "paused" })}
                  >
                    Pause
                  </button>
                )}
              </div>
              {item.result && <pre className="wf-result">{item.result}</pre>}
            </article>
          ))
        )}
      </section>
      {(page.url || log) && (
        <section className="wf-card">
          <header className="wf-subhead">
            <div>
              <h2>Run evidence</h2>
              <p>
                {page.title || page.url || "Local agent log"}
                {(page.tabId || activeTabId) &&
                  ` · ${page.tabId || activeTabId}`}
              </p>
            </div>
            <div className="wf-actions">
              <button
                onClick={() =>
                  void api("browser", { action: "tabs" })
                    .then((d: BrowserData) => {
                      setTabs(d.tabs || []);
                      setActiveTabId(d.activeTabId || "");
                      setLog(
                        (current) =>
                          `${current}\nRefreshed tab list: ${(d.tabs || []).map((t) => `${t.id} ${t.title || t.url}`).join(" | ") || "no tabs found"}`,
                      );
                    })
                    .catch((e: Error) => setLog(e.message))
                }
              >
                Refresh tabs
              </button>
              <button
                onClick={() =>
                  void api("browser", {
                    action: "inspect",
                    tabId: activeTabId || page.tabId,
                  })
                    .then((d: BrowserData) => {
                      setPage(d);
                      setTabs(d.tabs || []);
                      setActiveTabId(d.tabId || "");
                      setLog(
                        `Inspected tab ${d.tabId || "(unknown)"} · ${d.title || d.url}\n${d.text || ""}`,
                      );
                    })
                    .catch((e: Error) => setLog(e.message))
                }
              >
                Inspect selected tab
              </button>
            </div>
          </header>
          {tabs.length > 0 && (
            <label>
              OPEN BROWSER TABS
              <select
                value={activeTabId}
                onChange={(e) =>
                  void api("browser", {
                    action: "select-tab",
                    tabId: e.target.value,
                  })
                    .then((d: BrowserData) => {
                      setPage(d);
                      setTabs(d.tabs || []);
                      setSessionChecked(false);
                      setActiveTabId(d.activeTabId || d.tabId || "");
                      setLog(
                        `Selected browser tab ${d.tabId}: ${d.title || d.url}`,
                      );
                    })
                    .catch((err: Error) => setLog(err.message))
                }
              >
                {tabs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} · {t.title || "(untitled)"} · {t.url}
                  </option>
                ))}
              </select>
            </label>
          )}
          <pre className="wf-log">{log}</pre>
        </section>
      )}
      {approval && (
        <div className="wf-overlay">
          <section className="wf-approval">
            <span className="wf-kicker">USER APPROVAL REQUIRED</span>
            <h2>Allow this browser action?</h2>
            <p>{approval.detail}</p>
            <p>
              Review the visible target page first. Approving permits this
              single action only.
            </p>
            <div className="wf-actions">
              <button onClick={() => resolve(false)}>Reject / pause</button>
              <button className="danger" onClick={() => resolve(true)}>
                Approve once
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
