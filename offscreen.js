// offscreen.js
// Polls for whether the PES campus gateway is actually reachable —
// not a generic "is there some captive portal" guess. This is what
// stops the extension from doing anything at all on other Wi-Fi.

const GATEWAY_PROBE_URL = "http://192.168.254.1:8090/httpclient.html";
const PROBE_TIMEOUT_MS = 1200;

let lastOnCampus = null;
let keepaliveCounter = 0;

async function isOnCampusGateway() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    await fetch(GATEWAY_PROBE_URL, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timer);
    return true; // got any response at all from that IP = we're on that subnet
  } catch (e) {
    return false; // timeout / DNS fail / connection refused = different network
  }
}

async function tick() {
  const onCampus = await isOnCampusGateway();

  // Only message on a false->true transition, not every tick.
  if (onCampus && lastOnCampus !== onCampus) {
    chrome.runtime.sendMessage({ type: "captive-state", captive: true });
  }
  lastOnCampus = onCampus;

  if (onCampus) {
    keepaliveCounter += 1;
    if (keepaliveCounter >= 10) {
      keepaliveCounter = 0;
      chrome.runtime.sendMessage({ type: "keepalive-tick" });
    }
  } else {
    // Off campus entirely — don't let a stale counter fire a keepalive
    // the moment we happen to reconnect.
    keepaliveCounter = 0;
  }
}

tick();
setInterval(tick, 1000);
addEventListener("online", tick);
