const SHARD_COLORS = [
  { bg: "var(--s0)", edge: "var(--s0-edge)" },
  { bg: "var(--s1)", edge: "var(--s1-edge)" },
  { bg: "var(--s2)", edge: "var(--s2-edge)" },
  { bg: "var(--s3)", edge: "var(--s3-edge)" },
  { bg: "var(--s4)", edge: "var(--s4-edge)" },
];

function color(i) {
  return SHARD_COLORS[i % SHARD_COLORS.length];
}

const budget = document.getElementById("budget");
const latency = document.getElementById("latency");
const budgetVal = document.getElementById("budgetVal");
const latencyVal = document.getElementById("latencyVal");
const deprioritizeFlakes = document.getElementById("deprioritizeFlakes");
const testList = document.getElementById("testList");
const workerGrid = document.getElementById("workerGrid");
const runBtn = document.getElementById("runBtn");
const repoLabel = document.getElementById("repoLabel");

/** @type {null | {
 *   diffText: string,
 *   baselineRunId: string | null,
 *   hasBaseline: boolean,
 *   refLabel: string,
 *   staleAfterMs?: number,
 *   pruneAfterMs?: number,
 *   diffStat?: { lineCount?: number },
 * }} */
let boot = null;

/** @type {null | {
 *   selected: Array<{testId:string,source:string,durationMs:number,shardIndex:number|null,selected?:boolean,titlePath?:string,flaky?:boolean,flakeScore?:number,passes?:number,fails?:number}>,
 *   tests?: Array<{testId:string,source:string,durationMs:number,shardIndex:number|null,selected:boolean,titlePath?:string,flaky?:boolean,flakeScore?:number,passes?:number,fails?:number}>,
 *   shards: Array<{shardIndex:number,testIds:string[],durationMs:number}>,
 *   shardCount: number,
 *   baselineRunId: string,
 * }} */
let plan = null;

/** @type {Record<string, string>} */
let statuses = {};

/** @type {Map<string, any>} */
const workers = new Map();

let activeRunId = null;
let running = false;
let planTimer = null;
let ws = null;

function iconClass(st) {
  return "icon " + st;
}

function labelFor(t) {
  const title = t.titlePath ? String(t.titlePath).trim() : "";
  if (title) return title;
  const path = t.source ? String(t.source) : "";
  const id = String(t.testId ?? "");
  const short = id.includes("-")
    ? id.slice(id.lastIndexOf("-") + 1).slice(0, 8)
    : id.slice(-8);
  if (path && short) return `${path} · ${short}`;
  return path || short || id;
}

function planRows() {
  if (!plan) return [];
  if (Array.isArray(plan.tests) && plan.tests.length) return plan.tests;
  return (plan.selected ?? []).map((t) => ({ ...t, selected: true }));
}

function syncTestRow(li, t) {
  const inBudget = t.selected === true;
  const label = labelFor(t);
  const dur = `${Number(t.durationMs).toFixed(0)}ms`;
  const flaky = t.flaky === true;
  const flakeTitle = flaky
    ? [
        "Flaky",
        `${t.passes ?? 0} passed · ${t.fails ?? 0} failed`,
        typeof t.flakeScore === "number"
          ? `fail share ${(t.flakeScore * 100).toFixed(0)}%`
          : null,
      ]
        .filter(Boolean)
        .join(" — ")
    : "";

  if (!inBudget) {
    li.className = flaky ? "beyond flaky" : "beyond";
    li.removeAttribute("style");
    ensureRowDom(li);
    const icon = li.children[0];
    icon.className = "icon beyond";
    icon.removeAttribute("title");
    li.children[1].textContent = label;
    li.children[2].textContent = dur;
    const flake = li.children[3];
    flake.classList.toggle("is-empty", !flaky);
    flake.title = flakeTitle;
    flake.setAttribute("aria-hidden", flaky ? "false" : "true");
    return;
  }

  const st = statuses[t.testId] ?? "queued";
  const c = color(t.shardIndex);
  li.className = flaky ? "flaky" : "";
  li.style.background = c.bg;
  li.style.borderLeftColor = c.edge;
  ensureRowDom(li);
  const icon = li.children[0];
  const nextClass = iconClass(st);
  // Only touch className when status changes — keeps the spin animation continuous.
  if (icon.className !== nextClass) {
    icon.className = nextClass;
  }
  icon.title = st;
  li.children[1].textContent = label;
  li.children[2].textContent = dur;
  const flake = li.children[3];
  flake.classList.toggle("is-empty", !flaky);
  flake.title = flakeTitle;
  flake.setAttribute("aria-hidden", flaky ? "false" : "true");
}

function ensureRowDom(li) {
  if (
    li.children.length === 4 &&
    li.children[0].classList.contains("icon") &&
    li.children[2].classList.contains("dur") &&
    li.children[3].classList.contains("flake")
  ) {
    return;
  }
  li.innerHTML = `
    <span class="icon"></span>
    <span></span>
    <span class="dur"></span>
    <span class="flake is-empty" aria-hidden="true" aria-label="flaky">👻</span>`;
}

function renderList() {
  if (!plan) {
    testList.innerHTML =
      '<li style="opacity:.5;padding:.75rem"><span></span><span>No plan yet</span><span></span></li>';
    return;
  }
  const rows = planRows();
  if (rows.length === 0) {
    const msg =
      (boot?.diffStat?.lineCount ?? 0) === 0
        ? "No uncommitted app/ changes"
        : "No tests cover this diff";
    testList.innerHTML = `<li style="opacity:.5;padding:.75rem"><span></span><span>${msg}</span><span></span></li>`;
    return;
  }

  const scroll = testList.scrollTop;
  const existing = new Map();
  for (const li of testList.querySelectorAll("li[data-id]")) {
    existing.set(li.getAttribute("data-id"), li);
  }
  const keep = new Set(rows.map((t) => t.testId));
  for (const [id, li] of existing) {
    if (!keep.has(id)) li.remove();
  }

  for (const t of rows) {
    let li = existing.get(t.testId);
    if (!li) {
      li = document.createElement("li");
      li.setAttribute("data-id", t.testId);
    }
    syncTestRow(li, t);
    testList.appendChild(li);
  }
  testList.scrollTop = scroll;
}

/** @type {Map<string, string>} lastSeenAt we already pulsed for */
const pulsedAt = new Map();

function staleAfterMs() {
  return Number(boot?.staleAfterMs ?? 60_000);
}

function heartbeatFresh(lastSeenAt) {
  const ageMs = Math.max(0, Date.now() - new Date(lastSeenAt).getTime());
  return ageMs <= staleAfterMs();
}

function ensureWorkerCard(id) {
  let el = workerGrid.querySelector(`[data-worker-id="${CSS.escape(id)}"]`);
  if (el) return el;
  el = document.createElement("div");
  el.className = "worker";
  el.dataset.workerId = id;
  el.innerHTML = `
    <div class="top">
      <span class="id-row">
        <span class="hb" aria-hidden="true"></span>
        <span class="id"></span>
      </span>
      <span class="state"></span>
    </div>
    <div class="job"></div>`;
  workerGrid.appendChild(el);
  return el;
}

function triggerHeartbeatPulse(hb, lastSeenAt, workerId) {
  if (pulsedAt.get(workerId) === lastSeenAt) return;
  pulsedAt.set(workerId, lastSeenAt);
  hb.classList.remove("pulse");
  // Restart CSS animation.
  void hb.offsetWidth;
  hb.classList.add("pulse");
  const clear = () => {
    hb.classList.remove("pulse");
    hb.removeEventListener("animationend", clear);
  };
  hb.addEventListener("animationend", clear);
}

function pruneLocalWorkers() {
  const pruneMs = boot?.pruneAfterMs
    ? Number(boot.pruneAfterMs)
    : Number(boot?.staleAfterMs ?? 60_000) * 2;
  const now = Date.now();
  for (const [id, w] of [...workers.entries()]) {
    const age = Math.max(0, now - new Date(w.lastSeenAt).getTime());
    if (age > pruneMs) {
      workers.delete(id);
      pulsedAt.delete(id);
    }
  }
}

function renderWorkers() {
  pruneLocalWorkers();
  const list = [...workers.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );

  if (list.length === 0) {
    pulsedAt.clear();
    workerGrid.innerHTML =
      '<div class="worker idle"><div class="top"><span class="id-row"><span class="hb"></span><span class="id">no workers</span></span></div><div class="job">start npm run worker</div></div>';
    return;
  }

  // Drop placeholder / removed workers.
  for (const child of [...workerGrid.children]) {
    const id = child.getAttribute("data-worker-id");
    if (!id || !workers.has(id)) child.remove();
  }

  for (const w of list) {
    const el = ensureWorkerCard(w.id);
    const sh = w.shardIndex;
    const runningShard =
      w.state === "running" && sh !== null && sh !== undefined;
    const fresh = heartbeatFresh(w.lastSeenAt);

    const displayState = fresh ? w.state : "stale";

    el.className = `worker ${displayState}`;
    if (runningShard && fresh) {
      el.style.background = color(sh).bg;
      el.style.boxShadow = `inset 3px 0 0 ${color(sh).edge}`;
      el.style.borderColor = color(sh).edge;
    } else {
      el.style.background = "";
      el.style.boxShadow = "";
      el.style.borderColor = "";
    }

    el.querySelector(".id").textContent = w.id;
    const stateEl = el.querySelector(".state");
    stateEl.textContent = displayState;
    stateEl.style.color =
      runningShard && fresh ? color(sh).edge : "";

    el.querySelector(".job").textContent = runningShard
      ? `shard #${sh}${w.testIds ? ` · ${w.testIds.length}` : ""}`
      : "—";

    const hb = el.querySelector(".hb");
    hb.classList.toggle("ok", fresh);
    hb.title = fresh ? "heartbeat within policy" : "heartbeat stale";
    triggerHeartbeatPulse(hb, w.lastSeenAt, w.id);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function statusFromResult(status) {
  if (status === "running") return "running";
  if (status === "passed") return "ok";
  if (status === "failed" || status === "timedOut") return "fail";
  if (status === "skipped") return "skipped";
  return "running";
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

async function refreshPlan() {
  const budgetMs = Number(budget.value) * 1000;
  const latencyMs = Number(latency.value) * 1000;
  budgetVal.textContent = budget.value + "s";
  latencyVal.textContent = latency.value + "s";

  if (!boot?.hasBaseline) {
    plan = null;
    renderList();
    runBtn.disabled = true;
    return;
  }

  try {
    const body = {
      budgetMs,
      latencyMs,
      baselineRunId: boot.baselineRunId ?? undefined,
      diff: boot.diffText,
      deprioritizeFlakes: deprioritizeFlakes.checked,
    };
    plan = await fetchJson("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!running) {
      statuses = Object.fromEntries(
        plan.selected.map((t) => [t.testId, "queued"]),
      );
    }
    renderList();
    runBtn.disabled = running || plan.selected.length === 0;
  } catch (err) {
    console.error(err);
    plan = null;
    runBtn.disabled = true;
    testList.innerHTML = `<li style="opacity:.7"><span></span><span>${escapeHtml(String(err.message || err))}</span><span></span></li>`;
  }
}

function schedulePlan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(() => void refreshPlan(), 120);
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "snapshot") {
      workers.clear();
      for (const w of msg.workers ?? []) workers.set(w.id, w);
      renderWorkers();
      return;
    }
    if (msg.type === "worker") {
      workers.set(msg.worker.id, msg.worker);
      renderWorkers();
      // Per-test "running" comes from reporter onTestBegin via result events.
      return;
    }
    if (msg.type === "diff") {
      if (!running) void reloadDiff();
      return;
    }
    if (msg.type === "result" && msg.runId === activeRunId) {
      statuses[msg.testId] = statusFromResult(msg.status);
      renderList();
      return;
    }
    if (msg.type === "run" && msg.run?.id === activeRunId) {
      if (msg.run.status === "done" || msg.run.status === "failed") {
        running = false;
        runBtn.disabled = false;
        budget.disabled = false;
        latency.disabled = false;
        deprioritizeFlakes.disabled = false;
      }
    }
  });
  ws.addEventListener("close", () => {
    setTimeout(connectWs, 1500);
  });
}

async function reloadDiff() {
  if (running) return;
  try {
    boot = await fetchJson("/api/bootstrap");
    repoLabel.textContent = `${boot.repoLabel} · ${boot.refLabel}`;
    await refreshPlan();
  } catch (err) {
    console.error(err);
    repoLabel.textContent = String(err.message || err);
  }
}

async function onRun() {
  if (!boot || !plan || running) return;
  running = true;
  runBtn.disabled = true;
  budget.disabled = true;
  latency.disabled = true;
  deprioritizeFlakes.disabled = true;
  statuses = Object.fromEntries(plan.selected.map((t) => [t.testId, "queued"]));
  renderList();

  try {
    const created = await fetchJson("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: `ui-${new Date().toISOString()}`,
        diff: boot.diffText,
        budgetMs: Number(budget.value) * 1000,
        shardCount: plan.shardCount ?? plan.shards.length,
        baselineRunId: plan.baselineRunId,
        deprioritizeFlakes: deprioritizeFlakes.checked,
      }),
    });
    activeRunId = created.runId;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", runId: activeRunId }));
    }
    if (created.jobCount === 0) {
      running = false;
      runBtn.disabled = false;
      budget.disabled = false;
      latency.disabled = false;
      deprioritizeFlakes.disabled = false;
    }
  } catch (err) {
    console.error(err);
    running = false;
    runBtn.disabled = false;
    budget.disabled = false;
    latency.disabled = false;
    deprioritizeFlakes.disabled = false;
    alert(String(err.message || err));
  }
}

async function main() {
  budget.addEventListener("input", schedulePlan);
  latency.addEventListener("input", schedulePlan);
  deprioritizeFlakes.addEventListener("change", schedulePlan);
  runBtn.addEventListener("click", () => void onRun());

  boot = await fetchJson("/api/bootstrap");
  repoLabel.textContent = `${boot.repoLabel} · ${boot.refLabel}`;

  connectWs();
  await refreshPlan();
  setInterval(renderWorkers, 1000);
}

void main().catch((err) => {
  console.error(err);
  repoLabel.textContent = String(err.message || err);
});
