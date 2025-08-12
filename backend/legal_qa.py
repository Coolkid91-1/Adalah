"""Simple FAISS-based retrieval for Saudi laws (Arabic).

- Loads a prebuilt FAISS index and metadata JSON once at import time.
- Encodes Arabic queries using SentenceTransformers and returns top passages.
"""

from __future__ import annotations

import json
import logging
from typing import List, Dict, Any

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

# === Config ===
FAISS_INDEX = "ksa_laws_faiss.index"
METADATA_JSON = "ksa_laws_metadata.json"
EMBED_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"
TOP_K = 5

log = logging.getLogger(__name__)
if not log.handlers:
    logging.basicConfig(level=logging.INFO)

# Load index, metadata, and model once.
log.info("📥 Loading FAISS index and metadata...")
index = faiss.read_index(FAISS_INDEX)
with open(METADATA_JSON, "r", encoding="utf-8") as f:
    metadata: List[Dict[str, Any]] = json.load(f)

model = SentenceTransformer(EMBED_MODEL)


def search_laws(query: str, top_k: int = TOP_K) -> List[Dict[str, Any]]:
    """Return top_k metadata entries most similar to the query."""
    # SentenceTransformers typically return float32, but we ensure dtype.
    emb = np.asarray(model.encode(query), dtype=np.float32)
    distances, idxs = index.search(emb.reshape(1, -1), top_k)
    # Filter out-of-range indices (can occur if index > metadata length).
    results = [metadata[i] for i in idxs[0] if 0 <= i < len(metadata)]
    return results


def get_best_match_answer(question: str) -> str:
    """Build a short Arabic answer from the top retrieved passages.

    Returns up to the top 3 snippets, prefixed with (article_title) (law_title).
    """
    context_list = search_laws(question)
    if not context_list:
        return "لا توجد معلومات"

    parts: List[str] = []
    for entry in context_list:
        article_title = entry.get("article_title", "") or ""
        article_text = entry.get("text", "") or ""
        law_title = entry.get("law_title", "") or ""

        if article_title:
            parts.append(f"{article_title} ({law_title}):\n{article_text}")
        else:
            parts.append(f"({law_title}):\n{article_text}")

    # Limit to top 3 passages to keep it concise
    return "\n\n".join(parts[:3])
