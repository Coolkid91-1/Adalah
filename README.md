# Adalah Transcriber (Teams) — Chrome Extension + Azure STT Backend

A lightweight Chrome extension that embeds a side panel in Microsoft Teams pages, captures **microphone + (optional) system audio**, streams raw PCM to a local **WebSocket** backend powered by **Azure Speech-to-Text**, and provides **on‑demand legal Q&A** (Arabic) using a FAISS index of Saudi laws.

> ✅ **Transcription starts only when you click “ابدأ الاستماع”.**  
> ✅ **Legal answer appears only when you click “⚖️ اسأل عدالة”.**  
> 🔒 **Privacy:** Audio is streamed to your machine’s local backend (`ws://localhost:8765`) and not stored by default.

---

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Setup — Backend (Azure STT + Legal QA)](#setup--backend-azure-stt--legal-qa)
- [Setup — Chrome Extension](#setup--chrome-extension)
- [Usage](#usage)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)


---

## Architecture

```
 ┌─────────────────────────────── Chrome (Teams tab) ───────────────────────────────┐
 │                                                                                  │
 │  content.js  ── injects side panel (iframe)  ──────────────┐                    │
 │  transcriber.html + transcriber.js                         │                    │
 │    • Start/Stop buttons                                    │                    │
 │    • “Ask Adalah” button                                   │                    │
 │    • Captures mic + optional system audio                  │                    │
 │    • Mixes to 16 kHz mono Int16 PCM                        │                    │
 │    • Sends PCM frames over WS ─────────────────────────────┼────▶ ws://localhost:8765
 │    • Receives live transcript lines & on-demand answers ◀──┼────────────────────┘
 │                                                                                  │
 └──────────────────────────────────────────────────────────────────────────────────┘

 ┌────────────────────────────── Local Backend (Python) ─────────────────────────────┐
 │ app_ws.py                                                                         │
 │   • WebSocket server (websockets)                                                 │
 │   • Azure Speech SDK (ar-SA) continuous recognition                               │
 │   • Streams back recognized lines as they arrive                                  │
 │   • When client sends {type: "ask_answer"}:                                       │
 │       - legal_qa.get_best_match_answer(last_text)                                 │
 │       - Returns Arabic answer from FAISS index                                    │
 │                                                                                   │
 │ legal_qa.py                                                                       │
 │   • Loads FAISS index + metadata JSON                                             │
 │   • Embeds query with SentenceTransformers                                        │
 │   • Returns top passages (Arabic)                                                 │
 └───────────────────────────────────────────────────────────────────────────────────┘
```

---

## Features

- **Thin, expandable panel** injected on Teams pages.
- **Mic + optional system audio** capture and mixing; no tab muting.
- **Low-latency PCM** via `AudioWorklet`; safe fallback to `ScriptProcessor`.
- **Arabic transcription** using Azure Speech (region/language configurable).
- **On-demand legal answer** (Arabic), using FAISS search over Saudi laws.
- **No background auto-answers**—you stay in control.
- **No persistent storage** of audio or text by default.

---

## Repository Layout

Recommended structure (you can keep your current layout if you prefer):
```
repo/
├─ backend/
│  ├─ app_ws.py
│  ├─ legal_qa.py
│  ├─ requirements.txt
│  ├─ ksa_laws_faiss.index           # required (see Legal QA)
│  └─ ksa_laws_metadata.json         # required (see Legal QA)
└─ extension/
   ├─ manifest.json
   ├─ content.js
   ├─ transcriber.html
   ├─ transcriber.js
   ├─ background.js
   └─ icon.png
```

---

## Prerequisites

- **Python 3.9+** (Windows/macOS/Linux)
- **Google Chrome / Chromium**
- **Azure Speech** subscription key & region
- **FAISS index** + metadata JSON for the legal corpus:
  - `ksa_laws_faiss.index` and `ksa_laws_metadata.json` placed in `backend/` (same folder as `legal_qa.py`).

> **Note:** macOS does not expose “system audio” to Chrome display capture. Windows supports it via “Entire screen” + “Share system audio”.

---

## Setup — Backend (Azure STT + Legal QA)

1) **Create & activate a virtual environment**
```bash
cd backend
python -m venv .venv
# Windows PowerShell
. .venv/Scripts/Activate.ps1
# macOS/Linux
source .venv/bin/activate
```

2) **Install dependencies**
```bash
pip install -r requirements.txt
```

3) **Provide Azure credentials (Speech)**  
Set environment variables before running:

**PowerShell (Windows)**
```powershell
$env:AZURE_KEY='<your-speech-key>'
$env:AZURE_REGION='<your-region>'      # or your region
python app_ws.py
```

**CMD (Windows)**
```cmd
set AZURE_KEY=<your-speech-key>
set AZURE_REGION=<your-region>
python app_ws.py
```

**bash (macOS/Linux)**
```bash
export AZURE_KEY='<your-speech-key>'
export AZURE_REGION='eastus'
python app_ws.py
```

4) **Run the server**
```bash
python app_ws.py
```
You should see logs like:  
`starting server at ws://localhost:8765`

> The server writes a log file `transcriber_server.log` for diagnostics.

---

## Setup — Chrome Extension

1) **Open** `chrome://extensions`  
2) Enable **Developer mode** (top-right).  
3) Click **Load unpacked** and select the `extension/` folder.  
4) The extension targets Microsoft Teams domains and connects to `ws://localhost:8765`.

**System audio (Windows only):** when prompted to share, choose **Entire screen** and enable **Share system audio**.

---

## Usage

1) Open a **Teams** meeting or any Teams page.  
2) The side panel appears. By default it’s **thin**; click ↔ to **expand**.  
3) Click **“▶️ ابدأ الاستماع”**. Grant **microphone** (and **screen** for system audio) permissions.  
4) You’ll see live transcript lines under **“📝 النص المسموع”**.  
5) When you’re ready, click **“⚖️ اسأل عدالة”** to get a legal answer based on the **last** transcript line.  
6) Click **“⏹️ إيقاف”** to end the session.


---

## How It Works

### Audio capture & mixing (browser)
- The panel uses `getUserMedia` for the **mic** and `getDisplayMedia` for **system audio** (if available).
- Signals are mixed and downsampled to **16 kHz mono, 16-bit PCM** via an **AudioWorklet** (fallback to `ScriptProcessor` if needed).
- Binary PCM chunks are sent to the backend over **WebSocket**.

### WebSocket protocol (text + binary)
**Client → Server**
- **Binary:** raw PCM audio frames (`ArrayBuffer` with little-endian Int16 mono @ 16 kHz).
- **Text (JSON):**
  - `{"type":"ping","t":<timestamp>}` — keepalive
  - `{"type":"ask_answer"}` — request legal answer using the last recognized text
  - `{"type":"end_session"}` — close from client

**Server → Client**
- **Text (plain strings):**
  - `📄 المتحدث: <recognized-text>` — live transcript lines
  - `🤖 عدالة: <answer>` — Arabic legal answer (on demand)
  - Other info lines may appear for status/help

### Legal QA engine
- `legal_qa.py` loads:
  - `ksa_laws_faiss.index` (FAISS index)
  - `ksa_laws_metadata.json` (list of passages with fields such as `law_title`, `article_title`, `text`, etc.)
- Query is embedded using `SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")`.
- Top matches are concatenated into a concise **Arabic** answer.


---

## Configuration

- **Port:** `8765` (edit in `app_ws.py` if you need to change it).
- **Language:** `ar-SA` set in `app_ws.py`. You can change to e.g. `en-US` for English testing.
- **Azure credentials:** via environment variables `AZURE_KEY` and `AZURE_REGION`.
- **Legal index files:** keep them next to `legal_qa.py` or adjust the constants at the top of that file.

---

## Troubleshooting

**1) `SyntaxError: unterminated string literal` in `app_ws.py`**  
Use the latest `app_ws.py` where the missing-credentials error uses a triple-quoted string.

**2) “Permission dismissed / NotAllowedError” (browser)**  
You must accept Chrome prompts for microphone and (if you want system audio) display capture.

**3) No system audio captured (Windows)**  
When the display-capture sheet appears, choose **Entire screen** and enable **Share system audio**.  
> macOS currently does **not** provide system audio to Chrome display capture.

**4) “This page has been blocked by Chrome”**  
Usually happens when reloading content scripts or due to CSP. Close the tab, reopen Teams, and try again.

**5) WebSocket fails to connect**  
- Ensure the backend is running: `ws://localhost:8765`.  
- Firewall/AV software may block local WebSockets—allow Python on private networks.  
- Check `transcriber_server.log` for details.

**6) Nothing shows in the panel but backend logs show recognition**  
Open DevTools on the Teams page > Console. Look for content-script errors. Reload the page; re-grant permissions.

**7) Audio echoes or sounds muted**  
The extension **does not** mute the tab. If you hear echo, use a headset or enable echo cancellation (already on by default).

---

