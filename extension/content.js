// content.js — injects an embedded, compact transcriber panel (expandable).
(() => {
  "use strict";
  // Only run at top window and avoid duplicates.
  if (window.top !== window) return;
  if (document.getElementById("voice-transcriber-container")) return;

  // Resolve transcriber.html URL
  let transcriberURL = "";
  try {
    transcriberURL = chrome.runtime.getURL("transcriber.html");
  } catch (e) {
    console.error("Failed to resolve transcriber.html URL:", e);
    return;
  }

  // Sizing
  const COMPACT_WIDTH = 450;   // thin by default
  const EXPANDED_WIDTH = 820;  // one-click expand target
  const MIN_WIDTH = 280, MAX_WIDTH = 960, HEIGHT = 680;

  const wrap = document.createElement("div");
  wrap.id = "voice-transcriber-container";
  wrap.innerHTML = `
    <div id="voice-transcriber-panel"
         style="position:fixed;top:80px;right:20px;width:${COMPACT_WIDTH}px;height:${HEIGHT}px;
                display:flex;flex-direction:column;background:#121212;color:#fff;
                z-index:2147483647;border:1px solid #2b2b2b;border-radius:10px;overflow:hidden;
                box-shadow:0 10px 30px rgba(0,0,0,.6)">
      <div class="transcriber-header"
           style="display:flex;align-items:center;justify-content:space-between;
                  padding:8px 10px;background:#202020;border-bottom:1px solid #2b2b2b;cursor:move;user-select:none">
        <div style="font:600 14px system-ui;display:flex;align-items:center;gap:8px">
          <span>🎤</span> <span>Adalah Transcriber</span>
        </div>
        <div style="display:flex;gap:6px">
          <button id="expand-btn"   title="Expand/Restore"
            style="background:#333;color:#eee;border:0;width:30px;height:30px;border-radius:6px;cursor:pointer">↔</button>
          <button id="minimize-btn" title="Minimize"
            style="background:#333;color:#eee;border:0;width:30px;height:30px;border-radius:6px;cursor:pointer">−</button>
          <button id="close-btn"    title="Close"
            style="background:#333;color:#eee;border:0;width:30px;height:30px;border-radius:6px;cursor:pointer">×</button>
        </div>
      </div>

      <!-- Resize handle on the left edge -->
      <div id="resize-handle"
           style="position:absolute;top:0;left:0;height:100%;width:8px;cursor:col-resize;user-select:none;
                  background:linear-gradient(90deg, rgba(255,255,255,0.06), rgba(255,255,255,0))"></div>

      <iframe id="transcriber-frame"
          src="${transcriberURL}"
          allow="microphone; display-capture; clipboard-read; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          style="flex:1;border:0;background:#151515"></iframe>
    </div>

    <button id="voice-transcriber-toggle" title="Open Transcriber"
            style="position:fixed;right:20px;top:80px;width:48px;height:48px;border-radius:50%;
                   background:#3b82f6;color:#fff;border:none;box-shadow:0 8px 25px rgba(0,0,0,.4);
                   cursor:pointer;z-index:2147483646;display:none">🎤</button>
  `;
  document.body.appendChild(wrap);

  const panel = document.getElementById("voice-transcriber-panel");
  const toggle = document.getElementById("voice-transcriber-toggle");
  const minimizeBtn = document.getElementById("minimize-btn");
  const closeBtn = document.getElementById("close-btn");
  const expandBtn = document.getElementById("expand-btn");
  const frame = document.getElementById("transcriber-frame");
  const resizeHandle = document.getElementById("resize-handle");

  // Show panel immediately on Teams
  panel.style.display = "flex";
  toggle.style.display = "none";

  // Minimize / restore
  const hidePanel = () => { panel.style.display = "none"; toggle.style.display = "block"; };
  minimizeBtn.onclick = hidePanel;
  closeBtn.onclick = hidePanel;
  toggle.onclick = () => { panel.style.display = "flex"; toggle.style.display = "none"; };

  // Expand/restore
  let isExpanded = false; // will fix to boolean literal below
  let lastCompactWidth = COMPACT_WIDTH;
  expandBtn.onclick = () => {
    const currentWidth = panel.getBoundingClientRect().width;
    if (!isExpanded) {
      lastCompactWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(currentWidth)));
      panel.style.width = EXPANDED_WIDTH + "px";
      isExpanded = true;
    } else {
      panel.style.width = lastCompactWidth + "px";
      isExpanded = false;
    }
  };

  // Drag by header
  const header = panel.querySelector(".transcriber-header");
  let ox=0, oy=0, startLeft=0, startTop=0;
  header.onmousedown = (e) => {
    if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") return;
    e.preventDefault(); ox=e.clientX; oy=e.clientY; startLeft = panel.offsetLeft; startTop = panel.offsetTop;
    const onMove = (ev) => { ev.preventDefault(); const dx=ev.clientX-ox, dy=ev.clientY-oy;
      panel.style.top = (startTop + dy) + "px"; panel.style.left = (startLeft + dx) + "px"; };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Resize by left edge
  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const onMove = (ev) => {
      const dx = startX - ev.clientX;
      let next = Math.round(startWidth + dx);
      next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next));
      panel.style.width = next + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!isExpanded) lastCompactWidth = panel.getBoundingClientRect().width;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Notify iframe
  frame.addEventListener("load", () => {
    try { frame.contentWindow.postMessage({ type: "extension_ready" }, "*"); } catch {}
  });

  // Fix boolean literal to avoid any confusion
  isExpanded = !!isExpanded;
})();
