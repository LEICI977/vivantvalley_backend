const form = document.querySelector("[data-auth-form]");
const mode = document.body.dataset.authMode;
const message = document.getElementById("authMessage");
const submit = document.getElementById("authSubmit");
const invitationField = document.getElementById("invitationField");

function showMessage(text) {
  message.textContent = text;
  message.classList.remove("hidden");
}

function clearMessage() {
  message.textContent = "";
  message.classList.add("hidden");
}

function setSubmitting(active) {
  submit.disabled = active;
  submit.textContent = active ? (mode === "register" ? "正在创建账户..." : "正在登录...") : (mode === "register" ? "创建账户" : "登录");
}

async function loadPageState() {
  const [meResponse, configResponse] = await Promise.all([
    fetch("/api/v1/me"),
    fetch("/api/v1/auth/config"),
  ]);

  if (meResponse.ok) {
    const me = await meResponse.json();
    location.replace(me.role === "admin" ? "/admin" : "/app");
    return;
  }

  if (configResponse.ok && invitationField) {
    const config = await configResponse.json();
    invitationField.classList.toggle("hidden", !config.invitation_required);
    document.getElementById("invitationCode").required = Boolean(config.invitation_required);
  }
}

document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.passwordToggle);
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    button.textContent = visible ? "显示" : "隐藏";
    button.setAttribute("aria-pressed", String(!visible));
    input.focus();
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  if (mode === "register") {
    const confirmation = document.getElementById("passwordConfirmation").value;
    if (password !== confirmation) {
      showMessage("两次输入的密码不一致。");
      document.getElementById("passwordConfirmation").focus();
      return;
    }
  }

  const body = { email, password };
  const invitationCode = document.getElementById("invitationCode");
  if (mode === "register" && invitationCode && !invitationField.classList.contains("hidden")) {
    body.invitation_code = invitationCode.value.trim();
  }

  setSubmitting(true);
  try {
    const response = await fetch(`/api/v1/auth/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "请求失败，请稍后重试。");
    location.replace(data.user.role === "admin" ? "/admin" : "/app");
  } catch (error) {
    showMessage(error.message);
  } finally {
    setSubmitting(false);
  }
});

loadPageState().catch(() => {
  // Authentication remains usable even when the optional page-state request fails.
});
