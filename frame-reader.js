// Text reader. It is loaded on every page, but it only acts inside Page
// Sentinel's hidden page (an iframe named "sentinel:..." whose top frame is
// the extension itself). On any other page it does nothing.

(() => {
  const MAX_WAIT_MS = 20000; // max time waiting for the content to settle
  const QUIET_MS = 3000;     // the text must stay still for this long

  // Waits for the page to stop changing and returns its text, one line per
  // text fragment. Skips scripts and styles. It doesn't depend on the page
  // being visible, so it gives the same result in the hidden page and in a tab.
  function extractStableText(maxWaitMs, quietMs) {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT']);
    const read = () => {
      if (!document.body) return '';
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
            if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.nodeValue.replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
      }
      return out.join('\n');
    };

    return new Promise((resolve) => {
      let quietTimer = null;
      const finish = () => {
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        resolve(read());
      };
      // Every change on the page restarts the "quiet" countdown.
      const arm = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => (read() ? finish() : arm()), quietMs);
      };
      const observer = new MutationObserver(arm);
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      const maxTimer = setTimeout(finish, maxWaitMs);
      arm();
    });
  }

  // Used by the fallback (check in a tab).
  globalThis.__pageSentinelExtract = extractStableText;

  if (window === window.top) return;
  const token = String(window.name || '');
  if (!token.startsWith('sentinel:')) return;
  const origins = location.ancestorOrigins;
  const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
  if (!origins || origins[origins.length - 1] !== extensionOrigin) return;
  if (globalThis.__pageSentinelSent) return;
  globalThis.__pageSentinelSent = true;

  extractStableText(MAX_WAIT_MS, QUIET_MS).then((text) => {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'frameText', token, text }).catch(() => {});
  });
})();
