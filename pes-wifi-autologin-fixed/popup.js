// popup.js
// Manages a list of saved accounts (pes_accounts) plus which one is
// active (pes_active_id). background.js / content.js are unchanged —
// they still just read pes_username / pes_password, which this file
// keeps mirrored to whichever account is active.

const accountsEl = document.getElementById("accounts");
const addToggle = document.getElementById("addToggle");
const addForm = document.getElementById("addForm");
const unEl = document.getElementById("username");
const pwEl = document.getElementById("password");
const saveBtn = document.getElementById("saveBtn");
const cancelBtn = document.getElementById("cancelBtn");
const clearAll = document.getElementById("clearAll");
const msg = document.getElementById("msg");
const status = document.getElementById("status");
const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");

let accounts = [];
let activeId = null;

init();

async function init() {
  let state = await getStorage(["pes_accounts", "pes_active_id", "pes_username", "pes_password"]);

  // Migrate a pre-existing single-credential save into the accounts list.
  if ((!state.pes_accounts || state.pes_accounts.length === 0) && state.pes_username) {
    const migrated = { id: makeId(), username: state.pes_username, password: state.pes_password || "" };
    accounts = [migrated];
    activeId = migrated.id;
    await setStorage({ pes_accounts: accounts, pes_active_id: activeId });
  } else {
    accounts = state.pes_accounts || [];
    // undefined = key was never set yet -> default to first account.
    // null = explicitly paused -> respect that, don't auto-select anything.
    activeId = state.pes_active_id !== undefined ? state.pes_active_id : ((accounts[0] && accounts[0].id) || null);
  }

  render();
}

function render() {
  accountsEl.innerHTML = "";

  if (accounts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-accounts";
    empty.textContent = "No accounts saved yet";
    accountsEl.appendChild(empty);
    setStatus(false, "No credentials saved");
    return;
  }

  accounts.forEach((acc) => {
    const isActive = acc.id === activeId;
    const row = document.createElement("div");
    row.className = "account-row" + (isActive ? " active" : "");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = acc.username.slice(0, 2);

    const info = document.createElement("div");
    info.className = "acc-info";
    const user = document.createElement("div");
    user.className = "acc-user";
    user.textContent = acc.username;
    const sub = document.createElement("div");
    sub.className = "acc-sub";
    sub.textContent = isActive ? "Active now \u2014 tap to pause" : "Tap to switch";
    info.appendChild(user);
    info.appendChild(sub);

    const del = document.createElement("button");
    del.className = "acc-delete";
    del.title = "Remove";
    del.textContent = "\u00D7";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAccount(acc.id);
    });

    row.appendChild(avatar);
    row.appendChild(info);
    row.appendChild(del);

    row.addEventListener("click", () => toggleAccount(acc.id));
    accountsEl.appendChild(row);
  });

  const active = accounts.find((a) => a.id === activeId) || null;
  if (active) {
    setStatus(true, "Active — " + active.username);
  } else {
    setStatus(false, accounts.length ? "Paused — tap an account to resume" : "No credentials saved");
  }
}

// Clicking the already-active row pauses (deselects) it.
// Clicking any other row switches to that one.
async function toggleAccount(id) {
  if (id === activeId) {
    await pauseActive();
  } else {
    await switchAccount(id);
  }
}

async function pauseActive() {
  activeId = null;

  await setStorage({
    pes_active_id: null,
    pes_username: "",
    pes_password: "",
    isLoggingIn: false,
    loginStartedAt: 0,
    lastKeepAliveAt: 0
  });

  render();
  showMsg("Paused — autologin won't run", "err");
}

async function switchAccount(id) {
  if (id === activeId) return;
  activeId = id;
  const acc = accounts.find((a) => a.id === id);

  await setStorage({
    pes_active_id: id,
    pes_username: acc.username,
    pes_password: acc.password,
    isLoggingIn: false,
    loginStartedAt: 0,
    lastKeepAliveAt: 0
  });

  render();
  showMsg("Switched to " + acc.username, "ok");
}

async function removeAccount(id) {
  accounts = accounts.filter((a) => a.id !== id);

  if (activeId === id) {
    // Deleting the active account pauses rather than guessing which
    // other saved account you'd want running instead.
    activeId = null;

    await setStorage({
      pes_accounts: accounts,
      pes_active_id: null,
      pes_username: "",
      pes_password: "",
      isLoggingIn: false,
      loginStartedAt: 0,
      lastKeepAliveAt: 0
    });
  } else {
    await setStorage({ pes_accounts: accounts });
  }

  render();
  showMsg("Removed.", "err");
}

addToggle.addEventListener("click", () => {
  const opening = !addForm.classList.contains("open");
  addForm.classList.toggle("open", opening);
  addToggle.textContent = opening ? "Cancel" : "+ Add account";
  if (opening) unEl.focus();
  else { unEl.value = ""; pwEl.value = ""; }
});

cancelBtn.addEventListener("click", () => {
  addForm.classList.remove("open");
  addToggle.textContent = "+ Add account";
  unEl.value = "";
  pwEl.value = "";
});

saveBtn.addEventListener("click", async () => {
  const u = unEl.value.trim();
  const p = pwEl.value;
  if (!u || !p) { showMsg("Enter both fields!", "err"); return; }

  // Same username as an existing account -> update it instead of duplicating.
  const existing = accounts.find((a) => a.username === u);
  let targetId;
  if (existing) {
    existing.password = p;
    targetId = existing.id;
  } else {
    const acc = { id: makeId(), username: u, password: p };
    accounts.push(acc);
    targetId = acc.id;
  }
  activeId = targetId;

  await setStorage({
    pes_accounts: accounts,
    pes_active_id: activeId,
    pes_username: u,
    pes_password: p,
    isLoggingIn: false,
    loginStartedAt: 0,
    lastKeepAliveAt: 0
  });

  unEl.value = "";
  pwEl.value = "";
  addForm.classList.remove("open");
  addToggle.textContent = "+ Add account";
  render();
  showMsg(existing ? "Updated " + u : "Saved " + u, "ok");
});

clearAll.addEventListener("click", async () => {
  accounts = [];
  activeId = null;
  await removeStorage(["pes_accounts", "pes_active_id", "pes_username", "pes_password", "isLoggingIn", "loginStartedAt", "lastKeepAliveAt"]);
  render();
  showMsg("All accounts removed.", "err");
});

function setStatus(on, text) {
  status.className = "status " + (on ? "on" : "off");
  dot.className = "signal " + (on ? "on" : "off");
  statusText.textContent = text;
}

function showMsg(text, type) {
  msg.textContent = text;
  msg.className = "msg " + type;
  setTimeout(() => { msg.className = "msg"; }, 3000);
}

function makeId() {
  return (crypto.randomUUID ? crypto.randomUUID() : "acc_" + Date.now() + "_" + Math.random().toString(36).slice(2));
}

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function removeStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}
