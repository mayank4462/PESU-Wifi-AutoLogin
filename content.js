// content.js
// Only detects the login form and notifies background.js.
// background.js is the single place that actually fills/submits —
// keeping that in one place avoids two contexts racing on the same lock.

(function () {
  function notifyBackground() {
    chrome.runtime.sendMessage({ type: "login-trigger" });
  }

  if (document.querySelector("#username")) {
    notifyBackground();
    return;
  }

  const observer = new MutationObserver(() => {
    if (document.querySelector("#username")) {
      observer.disconnect();
      notifyBackground();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
