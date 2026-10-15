#!/usr/bin/env python3
"""
build_search_index.py — precompute a semantic search model that runs offline.

The requirement is full-content search plus semantic similarity with no
network, no runtime model download and no dependencies. A sentence-transformer
would mean shipping tens of megabytes and a WASM runtime, which defeats the
"works on a phone in an aircraft" goal.

Latent Semantic Analysis gets most of the way there for a fraction of the size.
Build a TF-IDF term-document matrix over the guidelines, factor it with a
truncated SVD, and ship two small matrices:

    terms[t]  -> k-dim vector     (so a *query* can be embedded without a model)
    docs[d]   -> k-dim vector

At runtime a query is embedded by summing the idf-weighted vectors of its
terms, and scored by cosine against the doc vectors. That is a handful of
multiply-adds in plain JavaScript. Because the factorisation puts terms that
co-occur near each other, "chest pain" retrieves the STEMI guideline and
"can't intubate" retrieves cricothyrotomy, without either phrase matching
literally.

Vectors are quantised to int8 and base64-encoded, which costs a little
precision and saves about 4x on file size.

Usage:  python3 tools/build_search_index.py
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
K = 64                     # latent dimensions
# Keep terms that appear in a single section. They looked like noise worth
# pruning, but they are the opposite: "snake" occurs only in Envenomation and
# is therefore the single most discriminating token for that section. Pruning
# them made "snake bite" unfindable.
MIN_DF = 1
MAX_DF_RATIO = 0.55        # ignore terms in more than half the sections

STOP = set("""
a an and are as at be been but by for from had has have if in into is it its
of on or that the their then there these they this to was were will with
you your not no do does doing done can could should would may might must
all any each other some such only own same than too very s t just now
patient patients consider considered per use used using given give giving
may should if when while after before during
""".split())

TOKEN = re.compile(r"[a-z][a-z0-9/%+-]{1,}")


def stem(w: str) -> str:
    """Very light suffix stripping. A full Porter stemmer is overkill for a
    corpus this size and mangles clinical terms ('ventilation' -> 'ventil')
    more than it helps."""
    for suf in ("ization", "ations", "ation", "ingly", "ings", "ing", "ies",
                "ied", "ied", "es", "ed", "ly", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def tokenize(text: str):
    out = []
    for m in TOKEN.finditer((text or "").lower()):
        w = m.group(0).strip("-/+")
        if len(w) < 2 or w in STOP:
            continue
        out.append(stem(w))
    return out


def doc_text(rec, kind):
    """Everything searchable about one section."""
    parts = [rec.get("title") or rec.get("name") or "", rec.get("number", "")]
    if kind == "guideline":
        parts.append(rec.get("section_title", ""))
        for b in rec.get("structure") or []:
            parts.append(b.get("care_level", ""))
            for it in b.get("items", []):
                parts.append(it["text"])
        if not rec.get("structure"):
            for b in rec.get("blocks", []):
                parts.extend(b.get("bullets", []))
    else:
        parts.append("formulary drug medication")
        for d in rec.get("doses", []):
            parts += [d.get("indication", ""), d.get("adult", ""),
                      d.get("pediatric", ""), d.get("neonatal", "")]
        for k, v in (rec.get("info") or {}).items():
            parts += [k, v]
    return "\n".join(p for p in parts if p)


def quant(mat):
    """int8 quantisation with one shared scale."""
    peak = float(np.abs(mat).max()) or 1.0
    scale = peak / 127.0
    q = np.clip(np.round(mat / scale), -127, 127).astype(np.int8)
    return base64.b64encode(q.tobytes()).decode("ascii"), scale


def main():
    content = json.loads((DATA / "content.json").read_text(encoding="utf-8"))

    docs, texts = [], []
    for g in content["guidelines"]:
        docs.append({"id": g["id"], "number": g["number"], "title": g["title"],
                     "kind": "guideline", "section": g["section_title"],
                     "page": g["page"], "levels": g.get("care_levels", [])})
        texts.append(doc_text(g, "guideline"))
    for d in content["drugs"]:
        docs.append({"id": d["id"], "number": d["number"], "title": d["name"],
                     "kind": "drug", "section": "Formulary",
                     "page": d["page"], "levels": []})
        texts.append(doc_text(d, "drug"))

    toks = [tokenize(t) for t in texts]
    n = len(docs)

    df = {}
    for ts in toks:
        for w in set(ts):
            df[w] = df.get(w, 0) + 1
    vocab = sorted(w for w, c in df.items()
                   if c >= MIN_DF and c <= n * MAX_DF_RATIO)
    vidx = {w: i for i, w in enumerate(vocab)}

    # TF-IDF (log tf, smoothed idf), L2-normalised per document.
    X = np.zeros((n, len(vocab)), dtype=np.float32)
    for d, ts in enumerate(toks):
        for w in ts:
            j = vidx.get(w)
            if j is not None:
                X[d, j] += 1.0
    idf = np.log((1 + n) / (1 + np.array([df[w] for w in vocab], dtype=np.float32))) + 1.0
    nz = X > 0
    tf = np.zeros_like(X)
    np.log(X, out=tf, where=nz)      # out= avoids uninitialised memory
    X = np.where(nz, 1.0 + tf, 0.0).astype(np.float32) * idf
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    X /= np.maximum(norms, 1e-9)

    # Truncated SVD:  X ≈ U S V^T.  Docs -> U*S, terms -> V.
    k = min(K, min(X.shape) - 1)
    U, S, Vt = np.linalg.svd(X, full_matrices=False)
    doc_vecs = (U[:, :k] * S[:k]).astype(np.float32)
    term_vecs = Vt[:k, :].T.astype(np.float32)        # (vocab, k)

    # Normalise so runtime scoring is a plain dot product.
    doc_vecs /= np.maximum(np.linalg.norm(doc_vecs, axis=1, keepdims=True), 1e-9)

    db64, dscale = quant(doc_vecs)
    tb64, tscale = quant(term_vecs)

    # The document's own glossary is a ready-made synonym table.
    abbrev = {}
    gl = next((g for g in content["guidelines"] if g["number"] == "10.02"), None)
    if gl:
        for b in gl.get("structure") or []:
            for it in b["items"]:
                m = re.match(r"^([A-Za-z0-9/]{2,8})\s*[–-]\s*(.+)$", it["text"].strip())
                if m:
                    abbrev[m.group(1).lower()] = re.sub(r"\s*\(.*?\)", "", m.group(2)).strip()

    # Lay/colloquial vocabulary that does not occur in the guidelines at all
    # ("sugar", "heart attack"). LSA cannot relate a term the corpus never
    # contains, so these are mapped explicitly.
    syn = {}
    sp = ROOT / "tools" / "synonyms.json"
    if sp.exists():
        raw = json.loads(sp.read_text(encoding="utf-8"))
        vocabset = set(vocab)
        for k_, vs in raw.items():
            if k_.startswith("_"):
                continue
            keep = [stem(v) for v in vs if stem(v) in vocabset]
            if keep:
                syn[k_] = sorted(set(keep))

    out = {
        "version": content["version"],
        "synonyms": syn,
        "dims": k,
        "docs": docs,
        "vocab": vocab,
        "idf": [round(float(v), 4) for v in idf],
        "termVecs": tb64, "termScale": tscale,
        "docVecs": db64, "docScale": dscale,
        "abbrev": abbrev,
    }
    p = DATA / "search.json"
    p.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"search.json: {n} docs, {len(vocab)} terms, k={k}, "
          f"{len(abbrev)} abbreviations, {p.stat().st_size/1024:.0f} KB")


if __name__ == "__main__":
    main()
