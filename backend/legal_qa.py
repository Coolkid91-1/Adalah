# legal_qa.py — Arabic legal QA (Retrieval + Ollama Generation)

import os
import json
import logging
from typing import List, Dict, Any, Tuple

import requests
import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

# ----------------
# Configuration
# ----------------
FAISS_INDEX    = os.getenv("FAISS_INDEX", "ksa_laws_faiss.index")
METADATA_JSON  = os.getenv("METADATA_JSON", "ksa_laws_metadata.json")
EMBED_MODEL    = os.getenv("EMBED_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")
TOP_K          = int(os.getenv("TOP_K", "5"))

# Ollama (local) generation
OLLAMA_MODEL   = os.getenv("OLLAMA_MODEL", "qwen2.5:3b-instruct") 
OLLAMA_URL     = os.getenv("OLLAMA_URL", "http://localhost:11434/api/generate")
OLLAMA_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "120"))

log = logging.getLogger(__name__)
if not log.handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

# ----------------
# Load knowledge
# ----------------
log.info("📥 Loading FAISS index and metadata...")
index = faiss.read_index(FAISS_INDEX)
with open(METADATA_JSON, "r", encoding="utf-8") as f:
    metadata: List[Dict[str, Any]] = json.load(f)

model = SentenceTransformer(EMBED_MODEL)

# ----------------
# Retrieval
# ----------------
def search_laws(query: str, top_k: int = TOP_K) -> List[Dict[str, Any]]:
    emb = np.asarray(model.encode(query), dtype=np.float32)
    _, idxs = index.search(emb.reshape(1, -1), top_k)
    return [metadata[i] for i in idxs[0] if 0 <= i < len(metadata)]

def get_best_match_answer(question: str) -> str:
    ctx = search_laws(question)
    if not ctx:
        return "لا توجد معلومات"
    parts = []
    for item in ctx[:3]:
        law_title = item.get("law_title", "قانون غير مُسمّى")
        art_title = item.get("article_title")
        text = (item.get("text") or "").strip()
        if not text:
            continue
        parts.append(f"{art_title} ({law_title}):\n{text}" if art_title else f"({law_title}):\n{text}")
    return "\n\n".join(parts) if parts else "لا توجد معلومات"

# ----------------
# Prompting
# ----------------
SYSTEM_AR = (
    "أنت مساعد قانوني خبير في الأنظمة السعودية. "
    "أجب بدقة وبالعربية الفصحى، واستند فقط إلى المقاطع المزوّدة في (المراجع). "
    "استخدم أرقام الاستشهاد [1] [2] داخل المتن حيث تلزم. "
    "إذا كانت المراجع غير كافية، صرّح بذلك صراحةً."
)

def _format_sources(contexts: List[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]]]:
    lines, cleaned = [], []
    for i, item in enumerate(contexts, start=1):
        law = item.get("law_title") or "قانون غير مُسمّى"
        art = item.get("article_title") or ""
        txt = (item.get("text") or "").strip()
        url = item.get("url") or ""
        snippet = txt if len(txt) <= 600 else txt[:600] + "…"
        title = (f"{art} — {law}" if art else law).strip(" —")
        line = f"[{i}] {title}\n{snippet}"
        if url:
            line += f"\nرابط: {url}"
        lines.append(line)
        cleaned.append(item)
    return "\n\n".join(lines), cleaned

def _build_prompt_ar(question: str, contexts: List[Dict[str, Any]], max_ctx_chars: int) -> str:
    total, kept = 0, []
    for c in contexts:
        t = (c.get("text") or "")
        if total + len(t) > max_ctx_chars and kept:
            break
        kept.append(c)
        total += len(t)

    refs_text, _ = _format_sources(kept)
    return (
        f"<النظام>\n{SYSTEM_AR}\n</النظام>\n\n"
        f"<السؤال>\n{question}\n</السؤال>\n\n"
        f"<المراجع>\n{refs_text}\n</المراجع>\n\n"
        "صُغ إجابة مختصرة ودقيقة ومدعّمة بالاستشهادات الرقمية ضمن النص (مثل [1]، [2]) "
        "واختم بفقرة: «المراجع المستند إليها: [1]، [2]، …». "
        "لا تضف معلومات من خارج المراجع."
    )

# ----------------
# Generation (Ollama)
# ----------------
def _generate_with_ollama(prompt: str, temperature: float = 0.2, top_p: float = 0.9, max_tokens: int = 700) -> str:
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "options": {"temperature": temperature, "top_p": top_p, "num_predict": max_tokens},
        "stream": False,
    }
    try:
        r = requests.post(OLLAMA_URL, json=payload, timeout=OLLAMA_TIMEOUT)
        r.raise_for_status()
        text = (r.json().get("response") or "").strip()
        if not text:
            raise RuntimeError("Empty response from Ollama.")
        return text
    except requests.exceptions.ConnectionError:
        raise RuntimeError(f"Cannot reach Ollama at {OLLAMA_URL}. Is `ollama serve` running?")
    except Exception as e:
        raise RuntimeError(f"Ollama generation failed: {e}")

# ----------------
# Public RAG API
# ----------------
def rag_answer(question: str, k_retrieve: int = 6, max_ctx_chars: int = 8000, backend: str = None) -> Dict[str, Any]:
    """
    Retrieves top-k passages, builds an Arabic prompt, and generates a grounded answer via Ollama.
    The 'backend' arg is ignored (kept for compatibility with existing callers).
    """
    ctxs = search_laws(question, top_k=k_retrieve)
    if not ctxs:
        return {
            "answer": "المعلومات المتاحة غير كافية للإجابة بثقة. (لا توجد نتائج مشابهة في الفهرس.)",
            "sources": [],
            "backend": "llama",
            "retrieved": 0,
        }

    prompt = _build_prompt_ar(question, ctxs, max_ctx_chars=max_ctx_chars)

    try:
        completion = _generate_with_ollama(prompt).strip()
    except Exception as e:
        log.error("RAG generation failed: %s", e)
        return {
            "answer": "تعذر توليد إجابة مُبرهنة حاليًا. فيما يلي مقتطفات ذات صلة:\n\n" + get_best_match_answer(question),
            "sources": ctxs[:3],
            "backend": "llama",
            "retrieved": len(ctxs),
        }

    if not completion or len(completion) < 20:
        completion = "تعذر توليد إجابة مُتكاملة من النموذج. فيما يلي مقتطفات مرتبطة بالسؤال:\n\n" + get_best_match_answer(question)

    return {
        "answer": completion,
        "sources": ctxs[:3],
        "backend": "llama",
        "retrieved": len(ctxs),
    }

# ----------------
# CLI
# ----------------
if __name__ == "__main__":
    import sys
    q = " ".join(sys.argv[1:]) or "ما هي شروط إنهاء عقد العمل؟"
    out = rag_answer(q, k_retrieve=6, max_ctx_chars=7000)
    print("\n===== الإجابة =====\n")
    print(out["answer"])
    print("\n===== المصادر =====\n")
    for i, s in enumerate(out["sources"], 1):
        law = s.get("law_title") or "قانون غير مُسمّى"
        art = s.get("article_title") or ""
        url = s.get("url") or ""
        title = (f"{art} — {law}" if art else law).strip(" —")
        print(f"[{i}] {title}")
        if url:
            print(f"   {url}")
