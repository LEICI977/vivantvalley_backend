const state = {
  me: null,
  keys: [],
  usage: [],
  usageTotals: { prompt_tokens: 0, completion_tokens: 0, cost_micros: 0 },
  ledger: [],
  catalog: { base_url: "https://www.vivantvalley.com.cn/v1", items: [] },
};

const csrf = () => decodeURIComponent((document.cookie.match(/(?:^|; )vv_csrf=([^;]*)/) || [])[1] || "");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[character]);

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  options.headers = { ...(options.headers || {}), "x-csrf-token": csrf() };
  const response = await fetch(path, options);
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      location.replace("/login");
      throw new ApiError("登录状态已过期。", response.status, data?.error?.code);
    }
    throw new ApiError(data?.error?.message || "请求失败，请稍后重试。", response.status, data?.error?.code);
  }
  return data;
}

const number = new Intl.NumberFormat("zh-CN");
const credits = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
const money = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatCredits(micros) {
  return credits.format((Number(micros) || 0) / 1_000_000);
}

function formatMoney(micros) {
  return `¥${money.format((Number(micros) || 0) / 1_000_000)}`;
}

function formatModelPrice(model) {
  const input = Number(model.input_micros_per_1k) || 0;
  const output = Number(model.output_micros_per_1k) || 0;
  const cached = Number(model.cached_input_micros_per_1k) || 0;
  if (input === output && output === cached) return `每 1,000,000 Token ${formatMoney(input * 1000)}`;
  return `输入 ${formatMoney(input * 1000)} / 1M；输出 ${formatMoney(output * 1000)} / 1M`;
}

function formatDate(value, fallback = "从未") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : dateTime.format(date);
}

function formatStatus(status) {
  const values = {
    completed: ["成功", "success"],
    failed: ["失败", "danger"],
    in_progress: ["处理中", "warning"],
  };
  return values[status] || [status || "未知", ""];
}

function ledgerLabel(kind) {
  return ({
    admin_topup: "额度充值",
    redeem: "兑换码入账",
    reservation: "调用预留",
    settlement: "调用结算",
    release: "预留退回",
    adjustment: "账户调整",
  })[kind] || kind;
}

function toast(text, type = "success") {
  const region = document.getElementById("toastRegion");
  const item = document.createElement("div");
  item.className = `toast${type === "error" ? " error" : ""}`;
  item.setAttribute("role", "status");
  item.textContent = text;
  region.append(item);
  setTimeout(() => item.remove(), 3600);
}

async function copyText(value, successText = "已复制") {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  toast(successText);
}

function activeKeys() {
  return state.keys.filter((key) => !key.revoked && (!key.expires_at || new Date(key.expires_at) > new Date()));
}

function renderAccount() {
  document.getElementById("headerEmail").textContent = state.me.email;
  document.getElementById("sideEmail").textContent = state.me.email;
  document.getElementById("balanceMetric").textContent = formatMoney(state.me.wallet.available_micros);
  document.getElementById("requestMetric").textContent = number.format(state.usage.length);
  document.getElementById("tokenMetric").textContent = number.format(state.usageTotals.prompt_tokens + state.usageTotals.completion_tokens);
  document.getElementById("keyMetric").textContent = number.format(activeKeys().length);
  document.getElementById("creditBalance").textContent = formatMoney(state.me.wallet.available_micros);
  document.getElementById("creditReserved").textContent = formatMoney(state.me.wallet.reserved_micros);
  if (state.me.role === "admin") document.getElementById("adminLink").classList.remove("hidden");
}

function renderSetup() {
  const firstModel = state.catalog.items[0]?.alias || "vv-dialogue";
  document.getElementById("setupBaseUrl").textContent = state.catalog.base_url;
  document.getElementById("setupModel").textContent = firstModel;
  const active = activeKeys();
  const keyState = document.getElementById("setupKeyState");
  keyState.textContent = active.length ? `已配置 ${active.length} 个可用设备 Key` : "尚未创建设备 Key";
  keyState.className = `status-badge ${active.length ? "success" : "warning"}`;

  const modelList = document.getElementById("modelList");
  modelList.innerHTML = state.catalog.items.length ? state.catalog.items.map((model) => `
    <div class="model-item">
      <div>
        <strong>${escapeHtml(model.alias)}</strong>
        <span>上下文 ${number.format(model.max_input_tokens)} · 最大输出 ${number.format(model.max_output_tokens)}</span>
      </div>
      <div class="model-price">
        ${formatModelPrice(model)}
      </div>
    </div>`).join("") : '<div class="empty-state"><div><strong>暂无可用模型</strong>请稍后刷新页面。</div></div>';
}

function usageRows(items) {
  return items.map((item) => {
    const [statusText, statusClass] = formatStatus(item.status);
    return `<tr>
      <td><span class="table-primary">${formatDate(item.created_at)}</span><span class="table-secondary table-code">${escapeHtml(item.request_id.slice(0, 12))}</span></td>
      <td><span class="table-code">${escapeHtml(item.model_alias)}</span></td>
      <td>${number.format(item.usage.prompt_tokens)} / ${number.format(item.usage.completion_tokens)}</td>
      <td>${formatMoney(item.cost_micros)}</td>
      <td><span class="status-badge ${statusClass}">${statusText}</span></td>
    </tr>`;
  }).join("");
}

function renderRecentUsage() {
  const container = document.getElementById("recentUsage");
  const items = state.usage.slice(0, 5);
  container.innerHTML = items.length ? `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>时间</th><th>模型</th><th>输入 / 输出 Token</th><th>扣除额度</th><th>状态</th></tr></thead>
    <tbody>${usageRows(items)}</tbody>
  </table></div>` : '<div class="empty-state"><div><strong>还没有调用记录</strong>配置设备 Key 后的请求会显示在这里。</div></div>';
}

function renderKeys() {
  const container = document.getElementById("keysTable");
  if (!state.keys.length) {
    container.innerHTML = '<div class="empty-state"><div><strong>还没有设备 Key</strong>创建后即可在 Mod 中连接托管服务。</div></div>';
    return;
  }
  container.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>设备</th><th>Key 前缀</th><th>创建时间</th><th>最近使用</th><th>到期时间</th><th>状态</th><th></th></tr></thead>
    <tbody>${state.keys.map((key) => {
      const expired = key.expires_at && new Date(key.expires_at) <= new Date();
      const available = !key.revoked && !expired;
      const stateText = key.revoked ? "已撤销" : expired ? "已过期" : "可用";
      return `<tr>
        <td><span class="table-primary">${escapeHtml(key.label)}</span></td>
        <td><span class="table-code">${escapeHtml(key.display_prefix)}...</span></td>
        <td>${formatDate(key.created_at)}</td>
        <td>${formatDate(key.last_used_at)}</td>
        <td>${formatDate(key.expires_at, "永不过期")}</td>
        <td><span class="status-badge ${available ? "success" : "danger"}">${stateText}</span></td>
        <td><div class="table-actions">${available ? `<button class="button-danger button-small" data-revoke-key="${escapeHtml(key.id)}" data-key-label="${escapeHtml(key.label)}">撤销</button>` : ""}</div></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function renderUsageFilters() {
  const model = document.getElementById("usageModelFilter");
  const selected = model.value;
  const aliases = [...new Set(state.usage.map((item) => item.model_alias))];
  model.innerHTML = '<option value="">全部模型</option>' + aliases.map((alias) => `<option value="${escapeHtml(alias)}">${escapeHtml(alias)}</option>`).join("");
  if (aliases.includes(selected)) model.value = selected;
}

function renderUsage() {
  const model = document.getElementById("usageModelFilter").value;
  const status = document.getElementById("usageStatusFilter").value;
  const filtered = state.usage.filter((item) => (!model || item.model_alias === model) && (!status || item.status === status));
  const container = document.getElementById("usageTable");
  document.getElementById("usageCountLabel").textContent = `${filtered.length} 条记录`;
  container.innerHTML = filtered.length ? `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>时间 / 请求 ID</th><th>模型</th><th>输入 / 输出 Token</th><th>扣除额度</th><th>状态</th></tr></thead>
    <tbody>${usageRows(filtered)}</tbody>
  </table></div>` : '<div class="empty-state"><div><strong>没有符合条件的记录</strong>调整筛选条件后再查看。</div></div>';
}

function renderLedger() {
  const container = document.getElementById("ledgerTable");
  if (!state.ledger.length) {
    container.innerHTML = '<div class="empty-state"><div><strong>暂无额度流水</strong>充值、兑换和模型调用会记录在这里。</div></div>';
    return;
  }
  container.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>时间</th><th>类型</th><th>变动</th><th>变动后余额</th><th>说明</th></tr></thead>
    <tbody>${state.ledger.map((entry) => {
      const amount = Number(entry.amount_micros) || 0;
      const amountClass = amount > 0 ? "positive" : amount < 0 ? "negative" : "";
      const amountText = amount > 0 ? `+${formatMoney(amount)}` : formatMoney(amount);
      return `<tr>
        <td>${formatDate(entry.created_at)}</td>
        <td><span class="table-primary">${escapeHtml(ledgerLabel(entry.kind))}</span></td>
        <td><span class="${amountClass}">${amountText}</span></td>
        <td>${formatMoney(entry.balance_after_micros)}</td>
        <td>${escapeHtml(entry.note || "-")}</td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function renderAll() {
  renderAccount();
  renderSetup();
  renderRecentUsage();
  renderKeys();
  renderUsageFilters();
  renderUsage();
  renderLedger();
}

async function loadAll({ quiet = false } = {}) {
  const refreshButtons = document.querySelectorAll("[data-refresh]");
  refreshButtons.forEach((button) => { button.disabled = true; });
  try {
    const [me, keys, usage, ledger, catalog] = await Promise.all([
      api("/api/v1/me"),
      api("/api/v1/keys"),
      api("/api/v1/usage"),
      api("/api/v1/ledger"),
      api("/api/v1/catalog"),
    ]);
    state.me = me;
    state.keys = keys.items;
    state.usage = usage.items;
    state.usageTotals = usage.totals;
    state.ledger = ledger.items;
    state.catalog = catalog;
    renderAll();
    if (!quiet) toast("数据已刷新");
  } catch (error) {
    if (error.status !== 401) toast(error.message, "error");
  } finally {
    refreshButtons.forEach((button) => { button.disabled = false; });
  }
}

function showView(name, updateHash = true) {
  const valid = ["overview", "keys", "usage", "credits"];
  const selected = valid.includes(name) ? name : "overview";
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.setAttribute("aria-current", button.dataset.view === selected ? "page" : "false");
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === selected);
  });
  if (updateHash && location.hash !== `#${selected}`) history.replaceState(null, "", `#${selected}`);
  document.querySelector(".console-main").focus({ preventScroll: true });
  scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

document.querySelectorAll("[data-open-key-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById("keyLabel").value = "";
    document.getElementById("keyExpiry").value = "0";
    document.getElementById("createKeyDialog").showModal();
    setTimeout(() => document.getElementById("keyLabel").focus(), 0);
  });
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog).close());
});

document.getElementById("createKeyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = document.getElementById("createKeySubmit");
  const days = Number(document.getElementById("keyExpiry").value);
  const body = { label: document.getElementById("keyLabel").value.trim() || "我的设备" };
  if (days > 0) body.expires_at = new Date(Date.now() + days * 86_400_000).toISOString();
  submit.disabled = true;
  submit.textContent = "正在创建...";
  try {
    const created = await api("/api/v1/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    document.getElementById("createKeyDialog").close();
    document.getElementById("createdKeyValue").textContent = created.key;
    document.getElementById("copyCreatedKey").dataset.copy = created.key;
    document.getElementById("createdKeyDialog").showModal();
    await loadAll({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    submit.disabled = false;
    submit.textContent = "创建 Key";
  }
});

document.getElementById("redeemForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = document.getElementById("redeemCode");
  const submit = document.getElementById("redeemSubmit");
  submit.disabled = true;
  submit.textContent = "正在兑换...";
  try {
    await api("/api/v1/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.value.trim() }),
    });
    code.value = "";
    toast("兑换成功，额度已到账");
    await loadAll({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    submit.disabled = false;
    submit.textContent = "兑换";
  }
});

document.getElementById("usageModelFilter").addEventListener("change", renderUsage);
document.getElementById("usageStatusFilter").addEventListener("change", renderUsage);

document.addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    await copyText(copy.dataset.copy, copy.dataset.copyMessage || "已复制");
    return;
  }
  const revoke = event.target.closest("[data-revoke-key]");
  if (revoke) {
    if (!confirm(`确认撤销“${revoke.dataset.keyLabel}”的设备 Key？撤销后无法恢复。`)) return;
    revoke.disabled = true;
    try {
      await api(`/api/v1/keys/${encodeURIComponent(revoke.dataset.revokeKey)}`, { method: "DELETE" });
      toast("设备 Key 已撤销");
      await loadAll({ quiet: true });
    } catch (error) {
      toast(error.message, "error");
      revoke.disabled = false;
    }
  }
});

document.querySelectorAll("[data-refresh]").forEach((button) => {
  button.addEventListener("click", () => loadAll());
});

document.getElementById("logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/v1/auth/logout", { method: "POST" });
    location.replace("/login");
  } catch (error) {
    if (error.status !== 401) toast(error.message, "error");
  }
});

window.addEventListener("hashchange", () => showView(location.hash.slice(1), false));

showView(location.hash.slice(1) || "overview", false);
loadAll({ quiet: true });
