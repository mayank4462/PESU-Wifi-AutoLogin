// background.js
// Keeps background checks running and silently re-authenticates
// whenever the captive portal takes over again.

const PORTAL_URL = "http://192.168.254.1:8090/httpclient.html";
const PORTAL_MATCH = "http://192.168.254.1:8090/*";
const LOGIN_LOCK_MS = 12000; // must exceed the slowest possible login flow (~8.5s), or the lock goes stale mid-attempt
const ALARM_PERIOD_MINUTES = 0.5;
const KEEPALIVE_INTERVAL_MS = 60000;

function ensureAlarm() {
  chrome.alarms.get("checkSession", (alarm) => {
    if (!alarm) {
      chrome.alarms.create("checkSession", { periodInMinutes: ALARM_PERIOD_MINUTES });
    }
  });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument || !chrome.runtime.getContexts) return;

  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_SCRAPING"],
    justification: "Monitor captive portal state every few seconds and trigger silent re-login quickly."
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  ensureOffscreenDocument().catch(() => {});
  checkSession();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  ensureOffscreenDocument().catch(() => {});
  checkSession();
});

ensureAlarm();
ensureOffscreenDocument().catch(() => {});
checkSession();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkSession") {
    checkSession();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "captive-state" && message.captive) {
    checkSession(true);
  }
  if (message?.type === "keepalive-tick") {
    ensureSessionFresh();
  }
  if (message?.type === "login-trigger") {
    checkSession();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url || !tab.url.startsWith("http://192.168.254.1:8090/")) return;
  if (changeInfo.status === "complete" || changeInfo.url) {
    checkSession();
  }
});

async function checkSession(forceLogin = false) {
  const state = await getStorage(["pes_username", "pes_password", "isLoggingIn", "loginStartedAt"]);

  if (!state.pes_username || !state.pes_password) return;

  if (state.isLoggingIn) {
    const elapsed = Date.now() - (state.loginStartedAt || 0);
    if (elapsed < LOGIN_LOCK_MS) return;
    await setStorage({ isLoggingIn: false, loginStartedAt: 0 });
  }

  const portalTabs = await chrome.tabs.query({ url: PORTAL_MATCH });
  if (portalTabs.length > 0) {
    const tab = portalTabs[0];

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => ({
          loggedIn: (document.body?.innerText || "").includes("You are signed in as"),
          loginFormVisible: !!document.querySelector("#username") && !!document.querySelector("#password"),
          submitReady: typeof submitRequest === "function" || !!document.querySelector("#loginbutton")
        })
      });

      const result = results[0]?.result;
      if (result?.loggedIn) return;

      if (result?.loginFormVisible && result?.submitReady) {
        await setStorage({ isLoggingIn: true, loginStartedAt: Date.now() });

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: fillAndSubmit,
            args: [state.pes_username, state.pes_password]
          });

          await waitForLoginSuccess(tab.id);
        } finally {
          await setStorage({ isLoggingIn: false, loginStartedAt: 0 });
        }
        return;
      }
    } catch (e) {
    }
  }

  // Not on PES Wi-Fi at all -> do nothing. No hidden tab, no lock held.
  const onCampus = await isOnCampusGateway();
  if (!onCampus) return;

  await setStorage({ isLoggingIn: true, loginStartedAt: Date.now() });

  let hiddenTabId = null;

  try {
    const hiddenTab = await chrome.tabs.create({ url: PORTAL_URL, active: false });
    hiddenTabId = hiddenTab.id;

    await waitForTabComplete(hiddenTabId);
    await waitForPortalReady(hiddenTabId, 3500);

    const result = await getPortalState(hiddenTabId);
    if (result?.loggedIn) return;
    if (!result?.loginFormVisible || !result?.submitReady) return;

    await chrome.scripting.executeScript({
      target: { tabId: hiddenTabId },
      world: "MAIN",
      func: fillAndSubmit,
      args: [state.pes_username, state.pes_password]
    });

    await waitForLoginSuccess(hiddenTabId);
  } catch (e) {
  } finally {
    if (hiddenTabId) {
      try {
        await chrome.tabs.remove(hiddenTabId);
      } catch (e) {
      }
    }
    await setStorage({ isLoggingIn: false, loginStartedAt: 0 });
  }
}

async function ensureSessionFresh() {
  const state = await getStorage([
    "pes_username",
    "pes_password",
    "isLoggingIn",
    "loginStartedAt",
    "lastKeepAliveAt"
  ]);

  if (!state.pes_username || !state.pes_password) return;

  if (state.isLoggingIn) {
    const elapsed = Date.now() - (state.loginStartedAt || 0);
    if (elapsed < LOGIN_LOCK_MS) return;
    await setStorage({ isLoggingIn: false, loginStartedAt: 0 });
  }

  const now = Date.now();
  if (now - (state.lastKeepAliveAt || 0) < KEEPALIVE_INTERVAL_MS) return;

  // This used to skip straight to opening a hidden tab with no check
  // on whether we were anywhere near PES Wi-Fi — that's the "random
  // tabs open on other networks" bug.
  const onCampus = await isOnCampusGateway();
  if (!onCampus) return;

  await setStorage({ lastKeepAliveAt: now });
  await touchPortalSession(state);
}

// Direct reachability probe for PES's own gateway — not a generic
// "does this look like some captive portal" guess. A short timeout
// means we fail fast on other networks instead of hanging.
async function isOnCampusGateway(timeoutMs = 1200) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    await fetch(PORTAL_URL, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timer);
    return true; // any response at all from that IP = we're on that subnet
  } catch (e) {
    return false; // timeout / DNS fail / connection refused = different network
  }
}

async function touchPortalSession(state) {
  let hiddenTabId = null;

  try {
    const hiddenTab = await chrome.tabs.create({ url: PORTAL_URL, active: false });
    hiddenTabId = hiddenTab.id;

    await waitForTabComplete(hiddenTabId, 3500);
    await waitForPortalReady(hiddenTabId, 3500);

    const result = await getPortalState(hiddenTabId);
    if (result?.loggedIn) return;

    if (result?.loginFormVisible && result?.submitReady) {
      await setStorage({ isLoggingIn: true, loginStartedAt: Date.now() });

      try {
        await chrome.scripting.executeScript({
          target: { tabId: hiddenTabId },
          world: "MAIN",
          func: fillAndSubmit,
          args: [state.pes_username, state.pes_password]
        });

        await waitForLoginSuccess(hiddenTabId, 3500);
      } finally {
        await setStorage({ isLoggingIn: false, loginStartedAt: 0 });
      }
    }
  } catch (e) {
  } finally {
    if (hiddenTabId) {
      try {
        await chrome.tabs.remove(hiddenTabId);
      } catch (e) {
      }
    }
  }
}

async function getPortalState(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => ({
        loggedIn: (document.body?.innerText || "").includes("You are signed in as"),
        loginFormVisible: !!document.querySelector("#username") && !!document.querySelector("#password"),
        submitReady: typeof submitRequest === "function" || !!document.querySelector("#loginbutton")
      })
    });

    return results[0]?.result || null;
  } catch (e) {
    return null;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 5000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;

  await new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitForLoginSuccess(tabId, timeoutMs = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => ({
          loggedIn: (document.body?.innerText || "").includes("You are signed in as"),
          loginFormVisible: !!document.querySelector("#username") && !!document.querySelector("#password")
        })
      });

      const result = results[0]?.result;
      if (result?.loggedIn || result?.loginFormVisible === false) {
        return;
      }
    } catch (e) {
    }

    await sleep(75);
  }
}

async function waitForPortalReady(tabId, timeoutMs = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await getPortalState(tabId);
    if (!result) {
      await sleep(75);
      continue;
    }

    if (result.loggedIn || (result.loginFormVisible && result.submitReady)) {
      return;
    }

    await sleep(75);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Injected into page - fills credentials and calls submitRequest()
function fillAndSubmit(user, pass) {
  const username = document.querySelector("#username");
  const password = document.querySelector("#password");
  if (!username || !password) return;

  const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (inputSetter) {
    inputSetter.call(username, user);
    inputSetter.call(password, pass);
  } else {
    username.value = user;
    password.value = pass;
  }
  username.dispatchEvent(new Event("input", { bubbles: true }));
  password.dispatchEvent(new Event("input", { bubbles: true }));
  username.dispatchEvent(new Event("change", { bubbles: true }));
  password.dispatchEvent(new Event("change", { bubbles: true }));

  setTimeout(() => {
    if (typeof submitRequest === "function") {
      submitRequest();
    } else {
      const loginLink = document.querySelector("#loginbutton")?.closest("a");
      if (loginLink) {
        loginLink.click();
      }
    }
  }, 50);

  setTimeout(() => {
    if ((document.body?.innerText || "").includes("You are signed in as")) return;
    if (!document.querySelector("#username") || !document.querySelector("#password")) return;
    if (typeof submitRequest === "function") {
      submitRequest();
    } else {
      const loginLink = document.querySelector("#loginbutton")?.closest("a");
      if (loginLink) {
        loginLink.click();
      }
    }
  }, 400);

  setTimeout(() => {
    if ((document.body?.innerText || "").includes("You are signed in as")) return;
    if (!document.querySelector("#username") || !document.querySelector("#password")) return;
    if (typeof submitRequest === "function") {
      submitRequest();
    } else {
      const loginLink = document.querySelector("#loginbutton")?.closest("a");
      if (loginLink) {
        loginLink.click();
      }
    }
  }, 1200);
}

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}
