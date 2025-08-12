
// transcriber.js — captures mic + (optional) system audio, streams to WS, shows transcripts.
// Kept minimal; comments added for clarity.
(() => {
  const WS_URL = "ws://localhost:8765";

  // --- UI refs/state ---
  let websocket, wsOpen = false, pingTimer = null;
  let startBtn, stopBtn, askBtn, transcriptFeed, responseFeed, statusEl, lastSnippetEl, jumpBtn;
  let lastTranscript = "";            // last line to send for Legal QA
  let autoscroll = true;              // auto-scroll transcript to latest

  // --- Audio graph state ---
  let audioCtx = null;
  let micStream = null;
  let sysStream = null;               // optional system/tab audio (Windows/Chrome)
  let workletNode = null;             // AudioWorkletNode for PCM generation
  let scriptProcessor = null;         // Fallback path

  document.addEventListener("DOMContentLoaded", init);
  const $ = (id) => document.getElementById(id);

  function init() {
    startBtn       = $("startButton");
    stopBtn        = $("stopButton");
    askBtn         = $("askButton");
    transcriptFeed = $("transcript");
    responseFeed   = $("response");
    statusEl       = $("status");
    lastSnippetEl  = $("lastSnippet");
    jumpBtn        = $("jump");

    startBtn.addEventListener("click", onStart);
    stopBtn.addEventListener("click", onStop);
    askBtn.addEventListener("click", onAsk);
    transcriptFeed.addEventListener("scroll", onTranscriptScroll);
    jumpBtn.addEventListener("click", jumpToBottom);

    setStatus("📱 الإضافة جاهزة - اضغط ابدأ للاتصال", "#bcd6ff");
    updateButtons();
  }

  // ---------- UI helpers ----------
  function setStatus(text, color) { statusEl.textContent = text; if (color) statusEl.style.color = color; }
  function updateButtons() {
    startBtn.disabled = wsOpen;
    stopBtn.disabled  = !wsOpen;
    askBtn.disabled   = !(wsOpen && lastTranscript.length > 0);
  }

  // ---------- Controls ----------
  async function onStart() {
    if (wsOpen) { setStatus("⚠️ الاتصال قائم بالفعل", "#ffb74d"); return; }
    connectWS();
    try {
      await startAudio(); // must be user-gesture initiated
    } catch (e) {
      setStatus(`❌ فشل تشغيل الصوت: ${e?.message || "غير معروف"}`, "#ef5350");
    }
    updateButtons();
  }

  function onStop() {
    stopAudio();
    closeWS();
    setStatus("⏹️ تم إنهاء الجلسة", "#ef9a9a");
    addSystem("⏹️ تم إيقاف الاستماع والجلسة.");
    updateButtons();
  }

  function onAsk() {
    if (!wsOpen) return;
    try { websocket.send(JSON.stringify({ type: "ask_answer" })); } catch {}
    if (lastTranscript) addInfo(responseFeed, "⚖️ تم إرسال طلب إجابة لـ:", lastTranscript);
  }

  // ---------- WebSocket ----------
  function connectWS() {
    setStatus("🔌 الاتصال بالخادم...", "#ffb74d");
    websocket = new WebSocket(WS_URL);
    websocket.binaryType = "arraybuffer";

    websocket.onopen = () => {
      wsOpen = true; updateButtons();
      setStatus("✅ متصل - يتم الاستماع الآن...", "#66bb6a");
      addSystem("تم الاتصال بالخادم — بانتظار الصوت...");
      pingTimer = setInterval(() => {
        try { websocket.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch {}
      }, 10000);
    };

    websocket.onmessage = (evt) => {
      const data = evt.data;
      if (typeof data === "string" && data.startsWith("{")) return; // ignore JSON control
      if (typeof data === "string") {
        if (data.startsWith("📄")) {
          const m = data.match(/^📄\s*(.*?):\s*(.*)$/);
          const speaker = m ? m[1] : "المتحدث";
          const line = m ? m[2] : data;
          addTranscript(speaker, line);
        } else if (data.startsWith("🤖")) {
          addAnswer(data.replace(/^🤖\s*/, ""));
        } else {
          addSystem(data);
        }
      }
    };

    websocket.onerror = () => setStatus("❌ فشل الاتصال بالخادم", "#ef5350");
    websocket.onclose  = () => {
      wsOpen = false; updateButtons();
      try { clearInterval(pingTimer); } catch {}
      setStatus("🔌 تم قطع الاتصال - يمكنك المحاولة مجددًا", "#ef5350");
    };
  }

  function closeWS() {
    try {
      if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
        websocket.close(1000, "user_stop");
      }
    } catch {}
  }

  // ---------- Audio capture + PCM conversion ----------
  const WORKLET_SOURCE = `
    class EnhancedPCMProcessor extends AudioWorkletProcessor {
      process(inputs){
        const input = inputs[0];
        if (input && input.length > 0) {
          const a = input[0];
          const b = input[1] || input[0];      // if only 1 ch is present, reuse
          const mono = new Float32Array(a.length);
          for (let i=0;i<mono.length;i++) mono[i] = Math.max(-1, Math.min(1, (a[i] + b[i]) * 0.5));
          const pcm = new Int16Array(mono.length);
          for (let i=0;i<mono.length;i++){ const s = Math.max(-1, Math.min(1, mono[i])); pcm[i] = s * 0x7FFF; }
          this.port.postMessage({ audioData: pcm.buffer }, [pcm.buffer]);
        }
        return true;
      }
    }
    registerProcessor("enhanced-pcm-processor", EnhancedPCMProcessor);
  `;

  async function startAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC({ sampleRate: 16000 });

    // 1) Ask for system/tab audio (Windows: choose Entire screen + Share system audio).
    let sysCandidate = null;
    try {
      sysCandidate = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "monitor" }, audio: true });
      sysCandidate.getVideoTracks().forEach(t => t.stop()); // drop video
    } catch { sysCandidate = null; }

    if (!sysCandidate || sysCandidate.getAudioTracks().length === 0) {
      // Fallback: user can still pick a tab/window with audio.
      try {
        const alt = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        alt.getVideoTracks().forEach(t => t.stop());
        sysCandidate = alt;
      } catch { sysCandidate = null; }
    }
    sysStream = (sysCandidate && sysCandidate.getAudioTracks().length > 0) ? sysCandidate : null;
    if (!sysStream) {
      addSystem("⚠️ لم يتم التقاط صوت النظام. على Windows: اختر \"Entire screen\" وفَعّل \"Share system audio\". (macOS لا يوفّر صوت النظام عبر المتصفح).");
    }

    // 2) Ask for microphone
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
        video: false
      });
    } catch (e) {
      throw e; // need at least the mic
    }

    // Prefer AudioWorklet for low-latency PCM. Mix mic + system into worklet input.
    let usedWorklet = false;
    try {
      if (audioCtx.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
        await audioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        workletNode = new AudioWorkletNode(audioCtx, "enhanced-pcm-processor", { numberOfInputs:1, numberOfOutputs:0 });

        const micGain = audioCtx.createGain(); micGain.gain.value = 0.9;
        audioCtx.createMediaStreamSource(micStream).connect(micGain).connect(workletNode);

        if (sysStream) {
          const sysGain = audioCtx.createGain(); sysGain.gain.value = 0.9;
          audioCtx.createMediaStreamSource(sysStream).connect(sysGain).connect(workletNode);
        }

        workletNode.port.onmessage = (ev) => {
          const buf = ev.data?.audioData;
          if (buf && wsOpen && websocket?.readyState === WebSocket.OPEN) { try { websocket.send(buf); } catch {} }
        };
        usedWorklet = true;  // <-- intentionally capitalized to test; we'll correct below
      }
    } catch (e) {
      console.error("AudioWorklet failed:", e?.message || e);
      usedWorklet = false;
    }
    // Fix capitalization slip (ensure boolean)
    usedWorklet = !!usedWorklet;

    if (!usedWorklet) {
      // Fallback: ScriptProcessor (mixed via a gain node, sent to a silent destination).
      const mixGain = audioCtx.createGain(); mixGain.gain.value = 1.0;
      audioCtx.createMediaStreamSource(micStream).connect(mixGain);
      if (sysStream) audioCtx.createMediaStreamSource(sysStream).connect(mixGain);

      scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
      mixGain.connect(scriptProcessor);
      const silentDest = audioCtx.createMediaStreamDestination(); // keep graph alive
      scriptProcessor.connect(silentDest);

      scriptProcessor.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        const buf = new ArrayBuffer(ch.length * 2);
        const view = new DataView(buf);
        for (let i=0;i<ch.length;i++){ let s=Math.max(-1,Math.min(1,ch[i])); view.setInt16(i*2, s<0?s*0x8000:s*0x7FFF, true); }
        if (wsOpen && websocket?.readyState === WebSocket.OPEN) { try { websocket.send(buf); } catch {} }
      };
    }

    setStatus("🎤 يتم الاستماع الآن...", "#66bb6a");
  }

  function stopAudio() {
    try { micStream?.getTracks().forEach(t=>t.stop()); } catch {}
    try { sysStream?.getTracks().forEach(t=>t.stop()); } catch {}
    micStream = sysStream = null;

    try { workletNode?.port?.close?.(); } catch {}
    try { workletNode?.disconnect?.(); } catch {}
    workletNode = null;

    try { scriptProcessor?.disconnect?.(); } catch {}
    scriptProcessor = null;

    try { audioCtx?.close?.(); } catch {}
    audioCtx = null;

    setStatus("⏹️ تم إيقاف الصوت", "#ef9a9a");
  }

  // ---------- Transcript UX ----------
  function onTranscriptScroll() {
    const nearBottom = transcriptFeed.scrollTop + transcriptFeed.clientHeight >= transcriptFeed.scrollHeight - 24;
    autoscroll = nearBottom;
    jumpBtn.style.display = autoscroll ? "none" : "inline-block";
  }
  function jumpToBottom() {
    transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
    autoscroll = true;
    jumpBtn.style.display = "none";
  }

  // ---------- Rendering helpers ----------
  function addTranscript(speaker, text) {
    const node = makeMsg({ who: speaker, time: nowStr(), text, tone: "in" });
    transcriptFeed.insertBefore(node, jumpBtn);
    if (autoscroll) jumpToBottom();

    lastTranscript = (text || "").trim();
    lastSnippetEl.textContent = lastTranscript.length > 120 ? lastTranscript.slice(0,120)+"…" : (lastTranscript || "—");
    updateButtons();
  }
  function addAnswer(text) {
    const node = makeMsg({ who: "عدالة", time: nowStr(), text, tone: "ai" });
    responseFeed.appendChild(node);
    responseFeed.scrollTop = responseFeed.scrollHeight;
  }
  function addSystem(text) {
    const node = makeMsg({ who: "النظام", time: nowStr(), text, tone: "in" });
    transcriptFeed.insertBefore(node, jumpBtn);
    if (autoscroll) jumpToBottom();
  }
  function addInfo(container, label, text) {
    const node = document.createElement("div");
    node.className = "msg msg--in";
    node.innerHTML = `
      <div class="msg__head"><div class="msg__who" style="color:#cfe2ff">${escapeHtml(label)}</div>
        <div class="msg__time">${nowStr()}</div></div>
      <div class="msg__txt">${escapeHtml(text)}</div>`;
    container.appendChild(node);
    container.scrollTop = container.scrollHeight;
  }
  function makeMsg({ who, time, text, tone }) {
    const msg = document.createElement("div");
    msg.className = `msg msg--${tone}`;
    msg.dataset.collapsed = "true";

    const head = document.createElement("div");
    head.className = "msg__head";

    const whoEl = document.createElement("div");
    whoEl.className = "msg__who"; whoEl.textContent = who;

    const timeEl = document.createElement("div");
    timeEl.className = "msg__time"; timeEl.textContent = time;

    const copy = document.createElement("button");
    copy.className = "copy"; copy.textContent = "نسخ"; copy.title = "نسخ النص";
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text || "").then(() => {
        copy.textContent = "✓ تم النسخ"; setTimeout(() => (copy.textContent = "نسخ"), 1000);
      });
    });

    const body = document.createElement("div");
    body.className = "msg__txt"; body.textContent = text || "";

    const expand = document.createElement("span");
    expand.className = "expand"; expand.textContent = "عرض المزيد";
    expand.addEventListener("click", (e) => {
      e.stopPropagation();
      const collapsed = msg.dataset.collapsed === "true";
      msg.dataset.collapsed = collapsed ? "false" : "true";
      expand.textContent = collapsed ? "إخفاء" : "عرض المزيد";
    });

    head.appendChild(whoEl); head.appendChild(timeEl);
    msg.appendChild(copy); msg.appendChild(head); msg.appendChild(body); msg.appendChild(expand);

    requestAnimationFrame(() => {
      const isOverflowing = body.scrollHeight > body.clientHeight + 2;
      msg.dataset.overflow = isOverflowing ? "true" : "false";
    });

    return msg;
  }
  function nowStr(){ try { return new Date().toLocaleTimeString("ar-SA",{hour:"2-digit",minute:"2-digit"});} catch { return new Date().toLocaleTimeString(); } }
  function escapeHtml(s){ return (s||"").replace(/[&<>"]/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
})();
