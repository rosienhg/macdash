"use strict";

// ================================================================ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmt = {
  bytes(n, digits = 1) {
    if (n == null) return "–";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
  },
  rate(n) { return n == null ? "–" : fmt.bytes(n) + "/s"; },
  pct(n, d = 0) { return n == null ? "–" : `${Number(n).toFixed(d)}%`; },
  temp(n) { return n == null ? "–" : `${Number(n).toFixed(1)}°C`; },
  watts(n) { return n == null ? "–" : `${Number(n).toFixed(1)} W`; },
  dur(sec) {
    if (sec == null) return "–";
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${sec}s`;
  },
  ago(t) { return t ? fmt.dur(Date.now() / 1000 - t) + " ago" : "–"; },
  date(t) { return t ? new Date(t * 1000).toLocaleString() : "–"; },
};

class ApiError extends Error {}

async function api(path, opts = {}) {
  const init = { credentials: "same-origin", ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers["content-type"] = "application/json";
  }
  const r = await fetch(path, init);
  if (r.status === 401 && path !== "/api/login") { showLogin(); throw new ApiError("unauthorized"); }
  const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(body?.detail || body || r.statusText);
  return body;
}

let toastTimer;
function toast(msg, err = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (err ? " err" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), err ? 7000 : 3500);
}

function statusFor(pct, warn = 70, crit = 90) {
  return pct >= crit ? "critical" : pct >= warn ? "warning" : "good";
}

// periodic tasks that only run while their tab is visible
const pollers = {};
function poll(name, fn, ms) {
  stopPoll(name);
  const tick = async () => {
    try { await fn(); } catch (e) { if (!(e instanceof ApiError && e.message === "unauthorized")) console.error(e); }
  };
  tick();
  pollers[name] = setInterval(() => { if (!document.hidden) tick(); }, ms);
}
function stopPoll(name) { clearInterval(pollers[name]); delete pollers[name]; }

// ================================================================ auth
function showLogin() {
  Object.keys(pollers).forEach(stopPoll);
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-token").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/login", { method: "POST", json: { token: $("#login-token").value.trim() } });
    $("#login-error").textContent = "";
    start();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ================================================================ theme
(function theme() {
  const saved = (() => { try { return localStorage.getItem("macdash-theme"); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  $("#theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("macdash-theme", next); } catch {}
    Object.values(charts).forEach((c) => c.draw());
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => Object.values(charts).forEach((c) => c.draw()));
})();

// ================================================================ tabs
let activeTab = "overview";
const tabHooks = {};

function setTab(name) {
  activeTab = name;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
  for (const [tab, hooks] of Object.entries(tabHooks)) {
    if (tab === name) hooks.enter?.(); else hooks.leave?.();
  }
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setTab(b.dataset.tab); });
document.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) setTab(g.dataset.goto); });

// ================================================================ drawer
function openDrawer(title, html) {
  $("#drawer-title").textContent = title;
  $("#drawer-body").innerHTML = html;
  $("#drawer").hidden = false;
  return $("#drawer-body");
}
function closeDrawer() {
  $("#drawer").hidden = true;
  $("#drawer-body").innerHTML = "";
  drawerCleanup?.();
  drawerCleanup = null;
}
let drawerCleanup = null;
$("#drawer").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });

// ================================================================ overview
const charts = {};
let history_ = [];
let interval = 2;
let range = 900;
let lastStats = null;
let battery = null;
let sysInfo = null;

const CHARTS = [
  { id: "cpu", title: "CPU & GPU", series: [{ key: "cpu", label: "CPU", color: "--s1" }, { key: "gpu", label: "GPU", color: "--s2" }], max: 100, format: (v) => fmt.pct(v) },
  { id: "mem", title: "Memory used", series: [{ key: "mem", label: "Memory", color: "--s1" }], max: 100, area: true, format: (v) => fmt.pct(v) },
  { id: "temp", title: "SoC temperature (max)", series: [{ key: "temp", label: "SoC", color: "--s2" }], area: true, format: (v, axis) => axis ? `${v.toFixed(0)}°` : fmt.temp(v) },
  { id: "power", title: "System power", series: [{ key: "power", label: "Power", color: "--s4" }], area: true, format: (v, axis) => axis ? `${v.toFixed(0)}W` : fmt.watts(v) },
  { id: "net", title: "Network", series: [{ key: "rx", label: "In", color: "--s1" }, { key: "tx", label: "Out", color: "--s2" }], format: (v, axis) => axis ? fmt.bytes(v, 0) : fmt.rate(v) },
  { id: "disk", title: "Disk I/O", series: [{ key: "dr", label: "Read", color: "--s1" }, { key: "dw", label: "Write", color: "--s2" }], format: (v, axis) => axis ? fmt.bytes(v, 0) : fmt.rate(v) },
];

function buildCharts() {
  const wrap = $("#charts");
  wrap.innerHTML = "";
  for (const c of CHARTS) {
    const card = document.createElement("div");
    card.className = "card chart-card";
    card.id = "chart-card-" + c.id;
    const legend = c.series.length > 1
      ? `<div class="legend">${c.series.map((s) => `<span style="--c:var(${s.color})">${s.label}</span>`).join("")}</div>` : "";
    card.innerHTML = `<div class="card-head"><h3>${c.title}</h3>${legend}<span class="now" id="now-${c.id}"></span></div><div class="chart"></div>`;
    wrap.append(card);
    charts[c.id] = new LineChart($(".chart", card), { series: c.series, max: c.max, format: c.format, area: c.area, interval });
  }
}

function drawCharts() {
  for (const c of CHARTS) {
    const hasData = history_.some((p) => c.series.some((s) => p[s.key] != null));
    $("#chart-card-" + c.id).hidden = !hasData && history_.length > 3;
    charts[c.id].setData(history_, range);
    const last = history_[history_.length - 1];
    if (last) $("#now-" + c.id).textContent = c.series.map((s) => last[s.key] == null ? "" : c.format(last[s.key])).filter(Boolean).join(" / ");
  }
}

$("#range").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  range = Number(b.dataset.range);
  $$("#range button").forEach((x) => x.classList.toggle("active", x === b));
  drawCharts();
});

function tile(label, value, unit, sub, meter, status) {
  return `<div class="tile">
    <div class="label">${label}</div>
    <div class="value">${value}${unit ? `<span class="unit">${unit}</span>` : ""}</div>
    <div class="sub">${status ? `<span class="status ${status[0]}">${esc(status[1])}</span> ` : ""}${sub || ""}</div>
    ${meter != null ? `<div class="meter"><i style="width:${Math.min(100, meter)}%;background:var(--${statusFor(meter) === "good" ? "accent" : statusFor(meter)})"></i></div>` : ""}
  </div>`;
}

function renderTiles() {
  const s = lastStats;
  if (!s) return;
  const soc = s.temps?.groups?.SoC;
  const mm = s.macmon;
  const memStatus = { normal: "good", warning: "warning", critical: "critical" }[s.mem.pressure] || "";
  const tiles = [
    tile("CPU", s.cpu.percent.toFixed(0), "%", `load ${s.cpu.load.map((l) => l.toFixed(2)).join(" · ")}`, s.cpu.percent),
    tile("Memory", s.mem.percent.toFixed(0), "%", `${fmt.bytes(s.mem.used)} / ${fmt.bytes(s.mem.total, 0)}${s.mem.swap_used ? ` · swap ${fmt.bytes(s.mem.swap_used)}` : ""}`, s.mem.percent,
      [memStatus, `pressure ${s.mem.pressure}`]),
  ];
  if (soc) {
    const st = soc.max >= 95 ? "critical" : soc.max >= 80 ? "warning" : "good";
    tiles.push(tile("SoC temperature", soc.max.toFixed(0), "°C", `avg ${soc.avg.toFixed(0)}°C`, null, [st, st === "good" ? "ok" : st === "warning" ? "hot" : "very hot"]));
  }
  if (mm) {
    tiles.push(tile("System power", (mm.power.system ?? 0).toFixed(1), "W", componentPower(mm.power) || "from SMC"));
    tiles.push(tile("GPU", ((mm.gpu.usage || 0) * 100).toFixed(0), "%", `${mm.gpu.freq || 0} MHz`, (mm.gpu.usage || 0) * 100));
  }
  if (battery) {
    const b = battery;
    const state = b.charging ? "charging" : b.plugged ? (b.fully_charged ? "charged" : "on AC, not charging") : "on battery";
    tiles.push(tile("Battery", Math.round(b.percent), "%", `health ${fmt.pct(b.health, 0)} · ${b.cycles} cycles`, null,
      [b.plugged ? "good" : b.percent < 20 ? "critical" : "warning", state]));
  }
  tiles.push(tile("Network", fmt.rate(s.net_io.rx).replace("/s", ""), "/s ↓", `${fmt.rate(s.net_io.tx)} ↑`));
  if (sysInfo) tiles.push(tile("Uptime", fmt.dur(Date.now() / 1000 - sysInfo.info.boot_time), "", `${s.procs} processes`));
  $("#tiles").innerHTML = tiles.join("");
}

function renderCores() {
  const s = lastStats;
  const mm = s.macmon;
  const perf = Number(sysInfo?.info.perf_cores) || 0;
  const eff = Number(sysInfo?.info.eff_cores) || 0;
  // On Apple Silicon logical CPUs are numbered E-cores first, then P-cores.
  const html = s.cpu.per_cpu.map((v, i) => {
    const isE = eff && i < eff;
    return `<div class="core ${isE ? "e" : "p"}" title="CPU ${i}${isE ? " (efficiency)" : perf ? " (performance)" : ""}: ${v.toFixed(0)}%"><div class="bar"><i style="height:${v}%"></i></div><span>${i}</span></div>`;
  }).join("");
  $("#cores").innerHTML = html + (eff ? "" : "");
  if (!$("#cores + .legend-inline") && eff) {
    $("#cores").insertAdjacentHTML("afterend", `<div class="legend-inline"><span style="--c:var(--s3)">Efficiency</span><span style="--c:var(--s1)">Performance</span></div>`);
  }
  $("#freqs").textContent = mm ? `E ${mm.ecpu.freq} MHz · P ${mm.pcpu.freq} MHz` : "";
}

function barRow(name, valueText, pct, title = "") {
  const st = statusFor(pct, 80, 92);
  return `<div class="barrow" title="${esc(title)}"><div class="top"><span class="name">${esc(name)}</span><span class="val">${valueText}</span></div>
    <div class="meter"><i style="width:${pct}%;background:var(--${st === "good" ? "accent" : st})"></i></div></div>`;
}

function renderDisks() {
  if (!sysInfo) return;
  $("#disks").innerHTML = sysInfo.disks.map((d) =>
    barRow(d.mount, `${fmt.bytes(d.used)} / ${fmt.bytes(d.total, 0)} · ${fmt.bytes(d.free)} free`, d.percent, `${d.device} (${d.fs})`)).join("");
}

// macmon's per-component power reads 0 on some macOS builds; only show it when real.
function componentPower(p) {
  const parts = [["CPU", p.cpu], ["GPU", p.gpu], ["ANE", p.ane], ["RAM", p.ram]].filter(([, v]) => v > 0);
  return parts.length ? parts.map(([k, v]) => `${k} ${fmt.watts(v)}`).join(" · ") : "";
}

function renderThermals() {
  const s = lastStats;
  const g = s.temps?.groups || {};
  const mm = s.macmon;
  let html = `<dl class="kv">`;
  for (const [name, v] of Object.entries(g)) html += `<dt>${esc(name)}</dt><dd>${fmt.temp(v.max)} max · ${fmt.temp(v.avg)} avg <span class="muted small">(${v.count} sensors)</span></dd>`;
  if (mm) {
    for (const f of mm.fans || []) html += `<dt>${esc(f.name)}</dt><dd>${f.rpm} rpm <span class="muted small">/ ${f.max_rpm}</span></dd>`;
    const p = mm.power;
    html += `<dt>System power</dt><dd>${fmt.watts(p.system)}</dd>`;
    const comp = componentPower(p);
    if (comp) html += `<dt>Components</dt><dd>${comp}</dd>`;
    html += `<dt>CPU clusters</dt><dd>E ${mm.ecpu.freq} MHz (${fmt.pct(mm.ecpu.usage * 100)}) · P ${mm.pcpu.freq} MHz (${fmt.pct(mm.pcpu.usage * 100)})</dd>`;
  } else {
    html += `<dt>Power</dt><dd class="muted">Install <code>macmon</code> for power, GPU and fan data</dd>`;
  }
  if (battery) html += `<dt>Battery flow</dt><dd>${fmt.watts(battery.watts)}${battery.adapter_watts ? ` · ${battery.adapter_watts} W adapter` : ""}</dd>`;
  html += `</dl>`;
  $("#thermals").innerHTML = html;
}

let topProcs = [];
function renderTopProcs() {
  const rows = [...topProcs].sort((a, b) => b.cpu - a.cpu).slice(0, 8);
  $("#top-procs tbody").innerHTML = rows.map((p) => `<tr class="click" data-pid="${p.pid}">
    <td>${esc(p.name)}</td><td class="num muted">${p.pid}</td><td class="num">${fmt.pct(p.cpu, 1)}</td><td class="num">${fmt.bytes(p.rss)}</td></tr>`).join("");
}
$("#top-procs").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-pid]"); if (tr) showProcess(Number(tr.dataset.pid)); });

async function refreshStats() {
  const since = history_.length ? history_[history_.length - 1].t : 0;
  const [stats, hist] = await Promise.all([api("/api/stats"), api("/api/history?since=" + since)]);
  lastStats = stats;
  interval = hist.interval;
  history_.push(...hist.points);
  const cutoff = Date.now() / 1000 - 3700;
  while (history_.length && history_[0].t < cutoff) history_.shift();
  $("#live-dot").className = "dot live";
  renderTiles(); renderCores(); renderThermals(); drawCharts();
}

async function refreshSlow() {
  const sys = await api("/api/system");
  sysInfo = sys;
  battery = sys.battery;
  $("#hostname").textContent = sys.info.hostname.replace(/\.local$/, "");
  $("#subtitle").textContent = `${sys.info.chip} · ${sys.info.os}`;
  document.title = `${$("#hostname").textContent} · macdash`;
  renderDisks();
  renderTiles();
}

async function refreshTopProcs() {
  if (activeTab !== "overview") return;
  topProcs = await api("/api/processes");
  renderTopProcs();
}

tabHooks.overview = {
  enter() {
    poll("top", refreshTopProcs, 4000);
    requestAnimationFrame(drawCharts);
  },
  leave() { stopPoll("top"); },
};

// Detect a dead backend (e.g. while it restarts).
setInterval(() => {
  const last = history_[history_.length - 1];
  if (last && Date.now() / 1000 - last.t > interval * 5) $("#live-dot").className = "dot stale";
}, 3000);

// ================================================================ processes
let procs = [];
let procSort = { key: "cpu", asc: false };
let me = null;

function renderProcs() {
  const q = $("#proc-filter").value.trim().toLowerCase();
  const mine = $("#proc-mine").checked;
  let rows = procs.filter((p) => (!mine || p.user === me) &&
    (!q || p.name.toLowerCase().includes(q) || String(p.pid) === q || (p.user || "").toLowerCase().includes(q)));
  const { key, asc } = procSort;
  rows.sort((a, b) => {
    const x = a[key] ?? -Infinity, y = b[key] ?? -Infinity;
    const r = typeof x === "string" ? x.localeCompare(y) : x - y;
    return asc ? r : -r;
  });
  $("#proc-count").textContent = `${rows.length} of ${procs.length}`;
  const now = Date.now() / 1000;
  $("#proc-table tbody").innerHTML = rows.slice(0, 500).map((p) => `<tr class="click" data-pid="${p.pid}">
    <td class="num muted">${p.pid}</td><td>${esc(p.name)}</td><td class="muted">${esc(p.user || "")}</td>
    <td class="num">${p.cpu.toFixed(1)}</td><td class="num">${fmt.bytes(p.rss)}</td><td class="num">${p.threads ?? ""}</td>
    <td class="num muted">${p.started ? fmt.dur(now - p.started) : ""}</td><td class="muted">${esc(p.status || "")}</td></tr>`).join("");
  $$("#proc-table th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === key);
    th.classList.toggle("asc", th.dataset.key === key && asc);
  });
}

$("#proc-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th");
  if (!th) return;
  const key = th.dataset.key;
  procSort = procSort.key === key ? { key, asc: !procSort.asc } : { key, asc: ["name", "user", "pid", "status"].includes(key) };
  renderProcs();
});
$("#proc-table tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-pid]"); if (tr) showProcess(Number(tr.dataset.pid)); });
["#proc-filter", "#proc-mine"].forEach((s) => $(s).addEventListener("input", renderProcs));

tabHooks.processes = {
  enter() {
    poll("procs", async () => {
      if ($("#proc-pause").checked) return;
      procs = await api("/api/processes");
      renderProcs();
    }, 3000);
  },
  leave() { stopPoll("procs"); },
};

async function showProcess(pid) {
  const body = openDrawer(`Process ${pid}`, `<p class="muted">Loading…</p>`);
  let d;
  try { d = await api(`/api/processes/${pid}`); } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  $("#drawer-title").textContent = `${d.name} (${pid})`;
  const mem = d.memory || {};
  body.innerHTML = `
    <div class="btn-row">
      <button class="btn" data-sig="TERM">Terminate (TERM)</button>
      <button class="btn danger" data-sig="KILL">Force kill (KILL)</button>
      <button class="btn" data-sig="HUP">HUP</button>
      <button class="btn" data-sig="STOP">Suspend</button>
      <button class="btn" data-sig="CONT">Resume</button>
    </div>
    <dl class="kv">
      <dt>Command</dt><dd class="mono">${esc((d.cmdline || []).join(" ") || d.exe || "–")}</dd>
      <dt>Executable</dt><dd class="mono">${esc(d.exe || "–")}</dd>
      <dt>Working dir</dt><dd class="mono">${esc(d.cwd || "–")}</dd>
      <dt>User</dt><dd>${esc(d.user || "–")}</dd>
      <dt>State</dt><dd>${esc(d.status || "–")} · nice ${d.nice ?? "–"}</dd>
      <dt>Parent</dt><dd>${d.ppid ? `<a href="#" data-pid="${d.ppid}">${esc(d.parent_name || "")} (${d.ppid})</a>` : "–"}</dd>
      <dt>Started</dt><dd>${fmt.date(d.started)} (${fmt.dur(d.uptime)})</dd>
      <dt>Memory</dt><dd>RSS ${fmt.bytes(mem.rss)} · virtual ${fmt.bytes(mem.vms)}</dd>
      <dt>CPU time</dt><dd>${d.cpu_times ? `user ${d.cpu_times.user.toFixed(1)}s · system ${d.cpu_times.system.toFixed(1)}s` : "–"}</dd>
      <dt>Threads / FDs</dt><dd>${d.threads ?? "–"} / ${d.fds ?? "–"}</dd>
    </dl>
    ${d.children.length ? `<h3>Children</h3><p>${d.children.map((c) => `<a href="#" data-pid="${c.pid}">${esc(c.name)} (${c.pid})</a>`).join(", ")}</p>` : ""}
    ${d.connections.length ? `<h3>Network connections</h3><table class="tbl compact"><tbody>${d.connections.map((c) =>
      `<tr><td>${c.type}</td><td class="mono">${esc(c.laddr)}</td><td class="mono">${esc(c.raddr)}</td><td class="muted">${esc(c.status)}</td></tr>`).join("")}</tbody></table>` : ""}
    ${d.open_files.length ? `<h3>Open files (${d.open_files.length})</h3><pre class="box">${esc(d.open_files.join("\n"))}</pre>` : ""}
  `;
  body.addEventListener("click", async (e) => {
    const link = e.target.closest("a[data-pid]");
    if (link) { e.preventDefault(); showProcess(Number(link.dataset.pid)); return; }
    const b = e.target.closest("[data-sig]");
    if (!b) return;
    const sig = b.dataset.sig;
    if (["TERM", "KILL", "STOP"].includes(sig) && !confirm(`Send SIG${sig} to ${d.name} (${pid})?`)) return;
    try {
      await api(`/api/processes/${pid}/signal`, { method: "POST", json: { signal: sig } });
      toast(`Sent SIG${sig} to ${pid}`);
      if (sig === "KILL" || sig === "TERM") setTimeout(closeDrawer, 400);
    } catch (err) { toast(err.message, true); }
  });
}

// ================================================================ services
let services = [];

function svcState(s) {
  if (s.state === "running" || (s.pid && s.loaded)) return ["good", "running"];
  if (!s.loaded) return ["", "unloaded"];
  const exit = s.last_exit;
  if (exit && exit !== 0 && exit !== "(never exited)") return ["critical", "exited " + exit];
  return ["warning", s.state && s.state !== "loaded" ? s.state : "loaded, idle"];
}

function renderServices() {
  const q = $("#svc-filter").value.trim().toLowerCase();
  const rows = services.filter((s) => !q || s.label.toLowerCase().includes(q) || (s.program || "").toLowerCase().includes(q));
  const order = { user: 0, agent: 1, daemon: 2, apple: 3 };
  rows.sort((a, b) => order[a.scope] - order[b.scope] || a.label.localeCompare(b.label));
  $("#svc-table tbody").innerHTML = rows.map((s) => {
    const [cls, text] = svcState(s);
    const flags = [s.run_at_load && "RunAtLoad", s.keep_alive && "KeepAlive", s.interval && `every ${s.interval}s`, s.calendar && "Calendar", s.protected && "protected"]
      .filter(Boolean).map((f) => `<span class="tag${f === "protected" ? " warn" : ""}">${f}</span>`).join("");
    return `<tr class="click" data-label="${esc(s.label)}">
      <td><span class="status ${cls}">${esc(text)}</span></td>
      <td><strong>${esc(s.label)}</strong>${s.error ? ` <span class="tag warn">bad plist</span>` : ""}</td>
      <td class="muted">${esc(s.scope)}</td>
      <td class="num">${s.pid ?? ""}</td>
      <td class="num muted">${s.last_exit ?? ""}</td>
      <td>${flags}</td>
      <td class="prog" title="${esc(s.program)}">${esc(s.program)}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">No services</td></tr>`;
}

async function loadServices() {
  services = await api("/api/services" + ($("#svc-apple").checked ? "?apple=1" : ""));
  renderServices();
}

$("#svc-filter").addEventListener("input", renderServices);
$("#svc-apple").addEventListener("change", loadServices);
$("#svc-refresh").addEventListener("click", loadServices);
$("#svc-table tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-label]"); if (tr) showService(tr.dataset.label); });
$("#svc-new").addEventListener("click", async () => {
  const label = prompt("Label for the new LaunchAgent (e.g. local.my-service):", "local.");
  if (!label) return;
  try {
    const { xml } = await api(`/api/services-template/${encodeURIComponent(label)}`);
    showPlistEditor(label, xml, true);
  } catch (e) { toast(e.message, true); }
});

tabHooks.services = {
  enter() { poll("svc", loadServices, 5000); },
  leave() { stopPoll("svc"); },
};

async function showService(label) {
  const body = openDrawer(label, `<p class="muted">Loading…</p>`);
  let d;
  try { d = await api(`/api/services/${encodeURIComponent(label)}`); } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const s = services.find((x) => x.label === label) || {};
  const sm = d.summary || {};
  const readonly = d.scope === "daemon" && !sysInfo?.sudo;
  const dis = readonly ? "disabled" : "";
  const logs = [...new Set([sm.stdout, sm.stderr].filter(Boolean))];
  body.innerHTML = `
    ${s.protected ? `<div class="notice">⚠️ ${label === "local.claude-rc" ? "This runs the Claude remote-control session." : "This is the dashboard itself."} Stopping it may cut off your access.</div>` : ""}
    ${readonly ? `<div class="notice">System daemon: read-only (control needs passwordless sudo).</div>` : ""}
    <div class="btn-row">
      <button class="btn" data-act="start" ${dis}>Start</button>
      <button class="btn" data-act="restart" ${dis}>Restart</button>
      <button class="btn" data-act="stop" ${dis} title="SIGTERM (KeepAlive jobs will respawn — use Unload)">Stop</button>
      ${d.loaded ? `<button class="btn danger" data-act="unload" ${dis}>Unload</button>` : `<button class="btn primary" data-act="load" ${dis || (d.path ? "" : "disabled")}>Load</button>`}
      <button class="btn ghost" data-act="enable" ${dis}>Enable</button>
      <button class="btn ghost" data-act="disable" ${dis}>Disable</button>
      ${sm.editable ? `<button class="btn" id="svc-edit">Edit plist</button>` : ""}
      ${sm.editable && !s.protected ? `<button class="btn ghost danger" id="svc-delete">Delete</button>` : ""}
    </div>
    <dl class="kv">
      <dt>Status</dt><dd><span class="status ${svcState(s)[0]}">${esc(svcState(s)[1])}</span>${s.pid ? ` · <a href="#" data-pid="${s.pid}">pid ${s.pid}</a>` : ""}</dd>
      <dt>Scope</dt><dd>${esc(d.scope)}</dd>
      <dt>Plist</dt><dd class="mono">${esc(d.path || "–")}</dd>
      ${sm.program ? `<dt>Program</dt><dd class="mono">${esc(sm.program)}</dd>` : ""}
      ${logs.length ? `<dt>Logs</dt><dd>${logs.map((l) => `<a href="#" data-log="${esc(l)}" class="mono">${esc(l)}</a>`).join("<br>")}</dd>` : ""}
    </dl>
    ${logs.length ? `<h3>Recent output</h3><pre class="box" id="svc-log">Loading…</pre>` : ""}
    <h3>launchctl print</h3><pre class="box">${esc(d.print)}</pre>
    ${d.plist_xml ? `<h3>Plist</h3><pre class="box">${esc(d.plist_xml)}</pre>` : ""}
  `;
  if (logs.length) {
    api(`/api/files/tail?lines=60&path=${encodeURIComponent(logs[0])}`)
      .then((r) => { const el = $("#svc-log"); if (el) { el.textContent = r.lines.join("\n") || "(empty)"; el.scrollTop = el.scrollHeight; } })
      .catch((e) => { const el = $("#svc-log"); if (el) el.textContent = e.message; });
  }
  body.addEventListener("click", async (e) => {
    const pidLink = e.target.closest("a[data-pid]");
    if (pidLink) { e.preventDefault(); showProcess(Number(pidLink.dataset.pid)); return; }
    const logLink = e.target.closest("a[data-log]");
    if (logLink) { e.preventDefault(); closeDrawer(); setTab("logs"); setLogMode("files"); openFile(logLink.dataset.log); return; }
    if (e.target.id === "svc-edit") { showPlistEditor(label, d.plist_xml, false); return; }
    if (e.target.id === "svc-delete") {
      if (!confirm(`Unload ${label} and move its plist to the backup folder?`)) return;
      try { const r = await api(`/api/services/${encodeURIComponent(label)}`, { method: "DELETE" }); toast(r.output); closeDrawer(); loadServices(); }
      catch (err) { toast(err.message, true); }
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (["stop", "unload", "restart", "disable"].includes(act) && (s.protected || act === "unload") &&
        !confirm(`${act} ${label}?${s.protected ? "\n\nThis is a protected service — you may lose access." : ""}`)) return;
    b.disabled = true;
    try {
      const r = await api(`/api/services/${encodeURIComponent(label)}/action`, { method: "POST", json: { action: act } });
      toast(`${act}: ${r.output || "ok"}`);
      await loadServices();
      setTimeout(() => { if (!$("#drawer").hidden && $("#drawer-title").textContent === label) showService(label); }, 800);
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });
}

function showPlistEditor(label, xml, isNew) {
  const body = openDrawer(`${isNew ? "New" : "Edit"}: ${label}`, `
    <p class="muted small">Saved to <code>~/Library/LaunchAgents/${esc(label)}.plist</code>. The previous version is backed up to <code>~/.config/macdash/plist-backups/</code>.</p>
    <textarea id="plist-xml" spellcheck="false"></textarea>
    <div class="btn-row">
      <button class="btn primary" id="plist-save-reload">Save &amp; ${isNew ? "load" : "reload"}</button>
      <button class="btn" id="plist-save">Save only</button>
      <button class="btn ghost" data-close>Cancel</button>
    </div>
    <p class="error" id="plist-err"></p>`);
  $("#plist-xml").value = xml;
  body.addEventListener("click", async (e) => {
    if (!["plist-save", "plist-save-reload"].includes(e.target.id)) return;
    const reload = e.target.id === "plist-save-reload";
    try {
      const r = await api(`/api/services/${encodeURIComponent(label)}/plist`, { method: "PUT", json: { xml: $("#plist-xml").value, reload } });
      toast(`Saved ${r.path}${reload ? " and reloaded" : ""}`);
      await loadServices();
      showService(label);
    } catch (err) { $("#plist-err").textContent = err.message; }
  });
}

// ================================================================ logs
let logMode = "unified";
let logES = null;

function setLogMode(mode) {
  logMode = mode;
  $$("#log-mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#log-unified").hidden = mode !== "unified";
  $("#log-files").hidden = mode !== "files";
  if (mode === "files") loadFiles();
}
$("#log-mode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setLogMode(b.dataset.mode); });

function logParams() {
  const f = new FormData($("#log-form"));
  const p = new URLSearchParams();
  for (const [k, v] of f.entries()) if (v !== "") p.set(k, v === "on" ? "true" : v);
  return p;
}

function logLineHtml(e) {
  return `<div class="logline"><span class="t">${esc(e.time.replace("T", " "))}</span><span class="lv lv-${esc(e.level.toLowerCase())}">${esc(e.level)}</span><span class="p" title="${esc(e.subsystem)} ${esc(e.category)}">${esc(e.process)}${e.pid ? `[${e.pid}]` : ""}</span><span class="m">${esc(e.message)}</span></div>`;
}

function stopLive() {
  if (logES) { logES.close(); logES = null; }
  $("#log-live").textContent = "▶ Live";
}

$("#log-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  stopLive();
  const out = $("#log-output");
  $("#log-status").textContent = "Searching…";
  out.innerHTML = "";
  try {
    const r = await api("/api/logs?" + logParams());
    out.innerHTML = r.entries.map(logLineHtml).join("") || `<div class="logline muted"><span></span><span></span><span></span><span>No entries</span></div>`;
    out.scrollTop = out.scrollHeight;
    $("#log-status").textContent = `${r.matched} matching entries${r.truncated ? `, showing the latest ${r.entries.length}` : ""}${r.timed_out ? " (query timed out — narrow the filter)" : ""}`;
  } catch (err) {
    $("#log-status").textContent = "";
    toast(err.message, true);
  }
});

$("#log-live").addEventListener("click", () => {
  if (logES) { stopLive(); $("#log-status").textContent = "Live stream stopped"; return; }
  const out = $("#log-output");
  out.innerHTML = "";
  const p = logParams();
  p.delete("minutes");
  logES = new EventSource("/api/logs/stream?" + p);
  $("#log-live").textContent = "■ Stop";
  $("#log-status").textContent = "Streaming…";
  let n = 0;
  logES.onmessage = (ev) => {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.insertAdjacentHTML("beforeend", logLineHtml(JSON.parse(ev.data)));
    if (++n > 3000) out.firstElementChild?.remove();
    if (atBottom) out.scrollTop = out.scrollHeight;
    $("#log-status").textContent = `Streaming… ${n} entries`;
  };
  logES.onerror = () => { $("#log-status").textContent = "Stream disconnected"; stopLive(); };
});

// --- files
let files = [];
let currentFile = null;
let fileES = null;
let fileLines = [];

async function loadFiles() {
  files = await api("/api/files");
  renderFiles();
}

function renderFiles() {
  const q = $("#file-filter").value.trim().toLowerCase();
  $("#file-list").innerHTML = files.filter((f) => !q || f.path.toLowerCase().includes(q) || f.source.toLowerCase().includes(q))
    .map((f) => `<li data-path="${esc(f.path)}" class="${f.path === currentFile ? "active" : ""}">
      <div class="p">${esc(f.path.replace(/^\/Users\/[^/]+/, "~"))}</div>
      <div class="meta">${fmt.bytes(f.size)} · ${fmt.ago(f.mtime)} · ${esc(f.source.replace(/^\/Users\/[^/]+/, "~"))}</div></li>`).join("");
}
$("#file-filter").addEventListener("input", renderFiles);
$("#file-list").addEventListener("click", (e) => { const li = e.target.closest("li[data-path]"); if (li) openFile(li.dataset.path); });

function renderFileLines() {
  const q = $("#file-grep").value;
  const out = $("#file-output");
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  let lines = fileLines;
  if (q) {
    const lq = q.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(lq));
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out.innerHTML = lines.map((l) => esc(l).replace(re, (m) => `<mark>${m}</mark>`)).join("\n");
  } else {
    out.textContent = lines.join("\n");
  }
  if (atBottom || !out.dataset.scrolled) { out.scrollTop = out.scrollHeight; out.dataset.scrolled = "1"; }
}
$("#file-grep").addEventListener("input", renderFileLines);
$("#file-wrap").addEventListener("change", (e) => $("#file-output").classList.toggle("wrap", e.target.checked));
$("#file-follow").addEventListener("change", () => currentFile && openFile(currentFile));

function stopFollow() { if (fileES) { fileES.close(); fileES = null; } }

async function openFile(path) {
  stopFollow();
  currentFile = path;
  renderFiles();
  $("#file-name").textContent = path;
  const out = $("#file-output");
  delete out.dataset.scrolled;
  out.textContent = "Loading…";
  let r;
  try { r = await api(`/api/files/tail?lines=2000&path=${encodeURIComponent(path)}`); }
  catch (e) { out.textContent = e.message; return; }
  if (currentFile !== path) return;
  fileLines = r.lines;
  renderFileLines();
  if ($("#file-follow").checked) {
    fileES = new EventSource(`/api/files/follow?start=${r.size}&path=${encodeURIComponent(path)}`);
    fileES.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.rotated) fileLines.push("──── file truncated / rotated ────");
      if (d.lines) fileLines.push(...d.lines);
      if (fileLines.length > 20000) fileLines = fileLines.slice(-15000);
      renderFileLines();
    };
  }
}

tabHooks.logs = {
  enter() { if (logMode === "files" && !files.length) loadFiles(); },
  leave() { stopLive(); stopFollow(); },
};

// ================================================================ system
function kv(pairs) {
  return pairs.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
}

async function loadSystem() {
  const [sys, net, power] = await Promise.all([api("/api/system"), api("/api/network"), api("/api/power")]);
  sysInfo = sys;
  const i = sys.info;
  $("#sys-info").innerHTML = kv([
    ["Hostname", esc(i.hostname)], ["Model", esc(i.model)], ["Chip", esc(i.chip)],
    ["Cores", `${i.cores_logical} (${i.perf_cores}P + ${i.eff_cores}E)`], ["Memory", fmt.bytes(i.mem_total, 0)],
    ["OS", esc(i.os)], ["Kernel", esc(i.kernel)], ["Booted", `${fmt.date(i.boot_time)} (${fmt.dur(i.uptime)} ago)`],
    ["Sessions", i.users.map((u) => `${esc(u.name)}@${esc(u.terminal)}`).join(", ") || "–"],
    ["Passwordless sudo", sys.sudo ? "yes" : "no (system daemons are read-only)"],
    ["macmon", i.macmon ? "installed" : "not installed"],
  ]);
  const b = sys.battery;
  $("#sys-battery").innerHTML = b ? kv([
    ["Charge", `${b.percent}%`],
    ["State", b.charging ? "charging" : b.plugged ? (b.fully_charged ? "charged (on AC)" : "on AC, not charging") : "discharging"],
    ["Health", `${fmt.pct(b.health, 1)} (${b.max_capacity} / ${b.design_capacity} mAh)`],
    ["Cycle count", b.cycles],
    ["Temperature", b.temperature != null ? fmt.temp(b.temperature) : fmt.temp(lastStats?.temps?.groups?.Battery?.max)],
    ["Voltage", b.voltage != null ? `${b.voltage} V` : null],
    ["Current", b.amperage != null ? `${b.amperage} mA (${fmt.watts(b.watts)})` : null],
    ["Adapter", b.adapter_watts ? `${b.adapter_watts} W` : null],
    ["Time remaining", b.time_remaining_min ? fmt.dur(b.time_remaining_min * 60) : null],
  ]) : `<dt>–</dt><dd class="muted">No battery</dd>`;
  $("#sys-ifaces tbody").innerHTML = net.interfaces.map((n) => `<tr><td><span class="status ${n.up ? "good" : ""}">${esc(n.name)}</span></td><td class="mono">${n.addresses.map(esc).join("<br>")}</td><td class="num muted">${n.speed ? n.speed + " Mb/s" : ""}</td></tr>`).join("");
  $("#sys-ports tbody").innerHTML = net.listening.map((p) => `<tr class="click" data-pid="${p.pid}"><td class="mono">${esc(p.address)}</td><td>${esc(p.command)}</td><td class="num muted">${p.pid}</td></tr>`).join("") || `<tr><td class="muted">None visible</td></tr>`;
  $("#sys-sensors tbody").innerHTML = (lastStats?.temps?.sensors || []).map((s) => `<tr><td>${esc(s.name)}</td><td class="muted">${esc(s.group)}</td><td class="num">${fmt.temp(s.value)}</td></tr>`).join("");
  $("#sys-pmset").textContent = power.pmset.trim();
  $("#sys-assert").textContent = power.assertions.trim();
}
$("#sys-ports").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-pid]"); if (tr) showProcess(Number(tr.dataset.pid)); });

tabHooks.system = {
  enter() { poll("sys", loadSystem, 15000); },
  leave() { stopPoll("sys"); },
};

// ================================================================ boot
async function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  if (!Object.keys(charts).length) buildCharts();
  try { await refreshSlow(); } catch (e) { if (e.message === "unauthorized") return; }
  me = sysInfo?.info.user || null;
  poll("stats", refreshStats, interval * 1000);
  poll("slow", refreshSlow, 30000);
  const tab = location.hash.slice(1);
  setTab(tabHooks[tab] ? tab : "overview");
}

start();
