# app_ws.py — Minimal WebSocket server for Azure STT + on-demand Legal QA (RAG).
# - Streams raw PCM (16 kHz, mono, 16-bit) from the client to Azure Speech.
# - Sends live transcript lines back immediately.

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Optional

import websockets  # pip install websockets>=12
# Azure SDK (pip install azure-cognitiveservices-speech)
try:
    import azure.cognitiveservices.speech as speechsdk  # type: ignore
except Exception as e:  # pragma: no cover
    raise RuntimeError("Azure Speech SDK missing. Run: pip install azure-cognitiveservices-speech") from e

# ---- Logging ----
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.FileHandler("transcriber_server.log", encoding="utf-8")],
)
log = logging.getLogger("adalah_ws")

# ---- Azure config ----
AZURE_KEY = os.getenv("AZURE_KEY", "").strip()
AZURE_REGION = os.getenv("AZURE_REGION", "").strip()
if not AZURE_KEY or not AZURE_REGION:
    raise RuntimeError(
        "Set AZURE_KEY and AZURE_REGION first."
        "PowerShell: $env:AZURE_KEY='...'; $env:AZURE_REGION='...'; python app_ws.py"
        "bash: export AZURE_KEY='...'; export AZURE_REGION='...'; python app_ws.py"
    )

# ---- Legal QA (RAG) hook ----
# Always use the RAG entrypoint from legal_qa.py
try:
    from legal_qa import rag_answer
    log.info("Legal QA (RAG) loaded.")
except Exception as e:  # pragma: no cover
    log.exception("Failed to import legal_qa: %s", e)

    def rag_answer(q: str, *args, **kwargs):  # final fallback if import fails
        return {"answer": "تعذر تحميل وحدة الإجابة القانونية.", "sources": [], "backend": "none", "retrieved": 0}

# ---- Per-connection session ----
class Session:
    """Holds per-client state and Azure recognizer objects."""

    def __init__(self, ws: websockets.WebSocketServerProtocol, loop: asyncio.AbstractEventLoop) -> None:
        self.ws = ws
        self.loop = loop
        self.pcm_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=100)
        self.running = True

        # Azure objects
        self.azure_push_stream: Optional[speechsdk.audio.PushAudioInputStream] = None
        self.azure_audio_cfg: Optional[speechsdk.audio.AudioConfig] = None
        self.azure_recognizer: Optional[speechsdk.SpeechRecognizer] = None
        self.azure_task: Optional[asyncio.Task] = None

        # Last recognized line (used when "ask_answer" is clicked)
        self.last_text: Optional[str] = None

    async def send_transcript(self, text: str) -> None:
        await self.ws.send(f"📄 المتحدث: {text}")

    async def send_answer(self, text: str) -> None:
        """
        Always use RAG (Ollama by default; HF fallback is handled inside legal_qa.py).
        Formats a short sources tail under the answer, aligned with [1][2]… citations.
        """
        try:
            out = rag_answer(text, k_retrieve=6, max_ctx_chars=7000, backend=os.getenv("RAG_BACKEND", "llama"))
            answer = (out.get("answer") or "").strip()
            sources = out.get("sources") or []

            tail_lines = []
            for i, s in enumerate(sources, 1):
                law = s.get("law_title") or "قانون غير مُسمّى"
                art = s.get("article_title") or ""
                url = s.get("url") or ""
                name = (f"{art} — {law}" if art else law).strip(" —")
                if url:
                    tail_lines.append(f"[{i}] {name}\n{url}")
                else:
                    tail_lines.append(f"[{i}] {name}")

            tail = ("\n\nالمراجع:\n" + "\n".join(tail_lines)) if tail_lines else ""
            payload = f"🤖 عدالة: {answer}{tail}" if answer else "🤖 عدالة: لا توجد إجابة."
        except Exception as e:
            log.error("RAG error: %s", e)
            payload = "🤖 عدالة: تعذر توليد إجابة مُبرهنة حاليًا."
        await self.ws.send(payload)

# ---- Azure continuous recognition ----
async def start_azure(session: Session) -> None:
    """Start continuous recognition and feed queued PCM to Azure."""
    log.info("Azure recognition starting...")
    fmt = speechsdk.audio.AudioStreamFormat(samples_per_second=16000, bits_per_sample=16, channels=1)
    session.azure_push_stream = speechsdk.audio.PushAudioInputStream(fmt)
    session.azure_audio_cfg = speechsdk.audio.AudioConfig(stream=session.azure_push_stream)

    speech_config = speechsdk.SpeechConfig(subscription=AZURE_KEY, region=AZURE_REGION)
    speech_config.speech_recognition_language = "ar-SA"

    recognizer = speechsdk.SpeechRecognizer(speech_config=speech_config, audio_config=session.azure_audio_cfg)
    session.azure_recognizer = recognizer

    # Callback from SDK (non-async): hop into event loop with run_coroutine_threadsafe
    def on_recognized(evt) -> None:
        text = (evt.result.text or "").strip()
        if not text:
            return

        async def push():
            session.last_text = text
            await session.send_transcript(text)

        asyncio.run_coroutine_threadsafe(push(), session.loop)

    recognizer.recognized.connect(on_recognized)

    async def feeder() -> None:
        while session.running:
            try:
                chunk = await session.pcm_q.get()
                session.azure_push_stream.write(chunk)
            except Exception as e:
                log.warning("Azure feeder error: %s", e)
                break

    async def run() -> None:
        recognizer.start_continuous_recognition()
        try:
            await feeder()
        finally:
            try:
                recognizer.stop_continuous_recognition()
            except Exception:
                pass
            try:
                session.azure_push_stream.close()
            except Exception:
                pass
            log.info("Azure recognition stopped.")

    session.azure_task = asyncio.create_task(run())

# ---- Incoming data handlers ----
async def handle_binary(session: Session, data: bytes) -> None:
    """Handle raw PCM chunks from the client."""
    try:
        session.pcm_q.put_nowait(data)
    except asyncio.QueueFull:
        # Drop the oldest frame to keep latency bounded.
        try:
            _ = session.pcm_q.get_nowait()
            await session.pcm_q.put(data)
        except Exception:
            pass

async def handle_text(session: Session, text: str) -> None:
    """Handle control messages from the client (JSON)."""
    if not text or not text.startswith("{"):
        return
    try:
        msg = json.loads(text)
    except Exception:
        return

    t = msg.get("type")
    if t == "end_session":
        await session.ws.close(code=1000, reason="user_stop")
    elif t == "ping":
        await session.ws.send(json.dumps({"type": "pong", "ts": time.time()}))
    elif t == "ask_answer":
        # Prefer explicit text from client; otherwise use last recognized transcript
        query = (msg.get("text") or "").strip() or (session.last_text or "").strip()
        if not query:
            await session.ws.send("🤖 عدالة: لا يوجد نص حديث للاستخدام.")
            return
        await session.send_answer(query)

# ---- WebSocket handler ----
async def handle_client(ws: websockets.WebSocketServerProtocol) -> None:
    sid = f"{ws.remote_address[0]}:{ws.remote_address[1]}"
    log.info("client connected: %s", sid)
    session = Session(ws, asyncio.get_running_loop())

    try:
        await ws.send("🤖 عدالة: مرحبا بك! النظام جاهز.")
        await session.send_transcript("تم الاتصال بالخادم — بانتظار الصوت...")
    except Exception:
        pass

    await start_azure(session)

    # Gentle reminder if no audio shows up
    async def watchdog():
        await asyncio.sleep(3)
        await session.send_transcript("إذا لم يظهر نص، تأكد من إذن الصوت في المتصفح.")
    asyncio.create_task(watchdog())

    try:
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                await handle_binary(session, bytes(msg))
            else:
                await handle_text(session, str(msg))
    except websockets.exceptions.ConnectionClosed:
        log.info("client disconnected: %s", sid)
    finally:
        session.running = False
        try:
            if session.azure_task:
                session.azure_task.cancel()
        except Exception:
            pass
        log.info("cleanup: %s", sid)

# ---- Entrypoint ----
async def main() -> None:
    host, port = "localhost", 8765
    log.info("starting server at ws://%s:%d", host, port)
    async with websockets.serve(handle_client, host, port, max_size=2**23):
        while True:
            await asyncio.sleep(30)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
