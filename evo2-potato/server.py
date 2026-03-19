"""Potato GBSS Mutation Scorer — powered by Evo 2 (7B base)."""

import os
from typing import Literal, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from Bio import SeqIO
from evo2 import Evo2

MODEL_NAME = os.getenv("EVO2_MODEL", "evo2_7b_base")
REFERENCE_FASTA = os.getenv("REFERENCE_FASTA", "potato_gbss.fasta")

app = FastAPI(title="Potato GBSS Mutation Scorer", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print(f"Loading model {MODEL_NAME}...")
model = Evo2(MODEL_NAME)
print("Model loaded.")

record = next(SeqIO.parse(REFERENCE_FASTA, "fasta"))
REF_ID = record.id
REFSEQ = "".join(base for base in str(record.seq).upper() if base in "ACGT")
print(f"Reference loaded: {REF_ID} ({len(REFSEQ)} bp)")


class MutationRequest(BaseModel):
    kind: Literal["snv", "del"] = "snv"
    pos: int = Field(..., ge=1)
    alt: Optional[str] = None
    window: Optional[int] = Field(default=None, ge=64, le=8000)


class BatchMutationRequest(BaseModel):
    mutations: list[MutationRequest]


def apply_mutation(seq: str, kind: str, pos: int, alt: Optional[str]) -> str:
    i = pos - 1
    if kind == "snv":
        if alt not in {"A", "C", "G", "T"}:
            raise ValueError("For SNVs, alt must be one of A/C/G/T.")
        return seq[:i] + alt + seq[i + 1 :]
    if kind == "del":
        return seq[:i] + seq[i + 1 :]
    raise ValueError(f"Unsupported mutation kind: {kind}")


def crop(seq: str, pos: int, window: Optional[int]) -> str:
    if window is None:
        return seq
    i = pos - 1
    half = window // 2
    start = max(0, i - half)
    end = min(len(seq), i + half)
    return seq[start:end]


def score_single(req: MutationRequest) -> dict:
    ref_base = REFSEQ[req.pos - 1]
    mutant_seq = apply_mutation(REFSEQ, req.kind, req.pos, req.alt)

    ref_window = crop(REFSEQ, req.pos, req.window)
    mutant_window = crop(mutant_seq, req.pos, req.window)

    ref_score = float(model.score_sequences([ref_window])[0])
    mutant_score = float(model.score_sequences([mutant_window])[0])
    delta = mutant_score - ref_score

    return {
        "reference_id": REF_ID,
        "model": MODEL_NAME,
        "mutation": {
            "kind": req.kind,
            "pos": req.pos,
            "ref": ref_base,
            "alt": req.alt,
        },
        "reference_score": ref_score,
        "mutant_score": mutant_score,
        "delta_score": delta,
        "interpretation": (
            "disruptive" if delta < -0.5 else "suspicious" if delta < 0 else "neutral"
        ),
    }


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_NAME,
        "reference_id": REF_ID,
        "reference_length": len(REFSEQ),
    }


@app.post("/score")
def score(req: MutationRequest):
    return score_single(req)


@app.post("/score/batch")
def score_batch(req: BatchMutationRequest):
    return {"results": [score_single(m) for m in req.mutations]}
