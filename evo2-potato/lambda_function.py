"""
Potato GBSS Mutation Scorer — Lambda calling Evo 2 via NVIDIA NIM API.

Scores the impact of DNA mutations in the potato GBSS gene (X83220.1, 5428 bp)
by comparing model predictions at the mutation site: reference vs. variant.

Environment variables:
  NVIDIA_API_KEY — API key from build.nvidia.com
"""

import json
import math
import os
import urllib.request

NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY", "")
NIM_URL = "https://health.api.nvidia.com/v1/biology/arc/evo2-7b/generate"

# Potato GBSS gene (X83220.1) — 5428 bp, clean ACGT only
REFSEQ = (
    "GATCTGACAAGTCAAGAAAATTGCCATTGAAGTCAGAGAATGAGAAGTTCGAGACACTGGCTACGGCTCA"
    "TCCAAGTAGCATTTGTATGGAATGTGACTTGTTTTATCTTTGCTCAGGAACCTGGACCTATAAGTGTTCC"
    "TATTTAACTAGCTAGTTCTATTGCCAAGTTTGTTTGGCGTCGTGCTGCTTATACAAACTTTGATCACATA"
    "TATACGTACGTTCACCATTTATTAATTAGGGAACTTTCACATGTAGCCACTCAAAAATAGCTCAATTATT"
    "CTCCATAGCTATAGTTTGATAATTACAATCTGTAGCTATATGTTATAGGGAGGAGAGAGGGGGCAAAGAG"
    "TGGGAGAAAGGTGAATTGTATATGTATATAGGTTAGATAATTGTATATTATACATATGTATTTGTATATT"
    "CTGGCGAATTATACATATACAAACGTGACTAATTATACACACTCGAAGTCAACCTGCATAATTAATGTAT"
    "AATGTTAGTCGTGAGTGATAATTATAGCAAACTATAGGTATGATGAGTAATTAAGTAGTATAAGTTTGCT"
    "TAATCGCGTAATTTTCCCCATTAATTATATATAAAATTCTTAAGAAATTCTCGAGGCAGTAAAGGTTCCA"
    "CAAATTGAAATCAGGAAGAAACTATTAACTAATCTATTTTCTTTTCTTCAACGACTACTACTTATTATAT"
    "TGGCTCTAAAGATAAGAGGATAATGAAACAAAGGAAGAAGCTTTAACGAGATAGAAAATTATATTACTCC"
    "GTTTTGTTCATTACTTAACAAATGCAACAGTATCTTGTACCAAATCCTTTCTCTCTTTTCAAACTTTTCT"
    "ATTTGGCTGTTGACAGAGTAATCAGGATACAAACCACAAGTATTTAATTGACTCATCCACCAGATATTAT"
    "GATTTATGAATCCTCGAAAAGCCTATCCATTAAGTTCTCATCTATGGATATACTTGACAGTTTCTTCCTA"
    "TTTGGGTATTTTTTTTTCCTGCCAAGTGGAACGGAGACATGTTATGTTGTATACGGGAAGCTCGTTAAAA"
    "AAAAAAATACAATAGGAAGAAATGTAACAAACATTGAATGTTGTTTTTAACCATCCTTCCTTTTAGCAGT"
    "GTATCAATTTTGTAATAGAACCATGCATCTCAATCTTAATACTAAAAAATGCAACAAAATTCTAGTGGAG"
    "GGACCAGTACCAGTACATTAGATATTATTTTTTATTACTATAATAATATTTTAATTAACACGAGACATAG"
    "GAATGTCAAGTGGTAGCGGTAGGAGGGAGTTGGTTTAGTTTTTTAGATACTAGGAGACAGAACCGGAGGG"
    "GCCCATTGCAAGGCCCAAGTTGAAGTCCAGCCGTGAATCAACAAAGAGAGGGCCCATAATACTGTCGATG"
    "AGCATTTCCCTATAATACAGTGTCCACAGTTGCCTTCCGCTAAGGGATAGCCACCCGCTATTCTCTTGAC"
    "ACGTGTCACTGAAACCTGCTACAAATAAGGCAGGCACCTCCTCATTCTCACACTCACTCACTCACACAGC"
    "TCAACAAGTGGTAACTTTTACTCATCTCCTCCAATTATTTCTGATTTCATGCATGTTTCCCTACATTCTA"
    "TTATGAATCGTGTTATGGTGTATAAACGTTGTTTCATATCTCATCTCATCTATTCTGATTTTGATTCTCT"
    "TGCCTACTGAATTTGACCCTACTGTAATCGGTGATAAATGTGAATGCTTCCTCTTCTTCTTCTTCTTCTC"
    "AGAAATCAATTTCTGTTTTGTTTTTGTTCATCTGTAGCTTGGTAGATTCCCCTTTTTGTAGACCACACAT"
    "CACATGGCAAGCATCACAGCTTCACACCACTTTGTGTCAAGAAGCCAAACTTCACTAGACACCAAATCAA"
    "CCTTGTCACAGATAGGACTCAGGAACCATACTCTGACTCACAATGGTTTAAGGGCTGTTAACAAGCTTGA"
    "TGGGCTCCAATCAAGAACTAATACTAAGGTAACACCCAAGATGGCATCCAGAACTGAGACCAAGAGACCT"
    "GGATGCTCAGCTACCATTGTTTGTGGAAAGGGAATGAACTTGATCTTTGTGGGTACTGAGGTTGGTCCTT"
    "GGAGCAAAACTGGTGGACTAGGTGATGTTCTTGGTGGACTACCACCAGCCCTTGCAGTAAGTCTTTCATT"
    "TGGTTACCTACTCATTCATTACTTATTTTGTTTAGTTAGGTTCTACTGCATCAGTCTTTTTATCATTTAG"
    "GCCCGCGGACATCGGGTAATGACAATATCCCCCCGTTATGACCAATACAAAGATACTTGGGATACTAGCG"
    "TTGCGGTTGAGGTACATCTTTCTATATTGATACGGTACAATATTGTTCTCTTACATTTCCTGATTCAAGA"
    "ATGTGATCCGCTACTTTATCTGCAGGTCAAAGTTGGAGACAGCATTGAAATTGTTCGTTTCTTTCACTGC"
    "TATAAACGTGGGGTTGATCGTGTTTTTGTTGACCACCCAATGTTCTTGGAGAAAGTAAGTAAGTATATTA"
    "TGATTATGAATCCATCCTGAGGGATACGCAGAACAGGTCATTTTGAATATCTTTTAACTCTACTGGTGCT"
    "TTTACTCTTTTAAGGTTTGGGGTAAAACTGGTTCAAAAATCTATGGCCCCAAAGCTGGACTAGATTATCT"
    "GGACAATGAACTTAGGTTCAGCTTGTTGTGTCAAGTAAGTTAGTTACTTGTTATACTGTTGTCTTGATTT"
    "TTATGTGGCATTTTACTCTTTAATCGTTTTTTTAACCTTGTTTTCTCAGGCAGCCCTAGAGGCACCTAAA"
    "GTTTTGAATTTGAACAGTAGCAACTACTTCTCAGGACCATATGGTAATTAACACATCCTAGTTTCAGAAA"
    "ACTCCTTAGTATATCATTGTAGGTAATCATCTTTATTTTGCCTATTCCTGCAGGAGAGGATGTTCTCTTC"
    "ATTGCCAATGATTGGCACACAGCTCTCATTCCTTGCTACTTGAAGTCAATGTACCAGTCCAGAGGAATCT"
    "ATTTGAATGCCAAGGTAAAATTTCTTTGTATTCACTTGATTGCACTTTACCCTGCAAATCAGTAAGGTTG"
    "TATTAATATATGATAAATTTCACATTGCCTCCAGGTCGCTTTCTGCATCCATAACATTGCCTACCAAGGC"
    "CGATTTTCTTTCTCTGACTTCCCTCTTCTCAATCTTCCTGATGAATTCAGGGGTTCTTTTGATTTCATTG"
    "ATGGGTATGTATTTAATGCTTGAAATCAGACCACCAACTTTTGAAGCTCTTTTGATGCTAGTAAATTGAG"
    "TTTTTAAAATTTTGCAGTTATGAGAAGCCTGTTAAGGGTAGGAAAATCAACTGGATGAAGGCTGGGATAT"
    "TAGAATCACATAGGGTGGTTACAGTGAGCCCATACTATGCCCAAGAACTTGTCTCTGCTGTTGACAAGGG"
    "TGTTGAATTGGACAGTGTCCTTCGAAAGACTTGCATAACTGGGATTGTGAATGGCATGGATACACAAGAG"
    "TGGAACCCAGCGACTGACAAATACACAGATGTCAAATACGATATAACCACTGTAACATAAGATTTTTCCA"
    "ACTCCAGTATATACTAAATTATTTTGTATGTTTATGAAATTAAAGAGTTCTTGCTAATCAAAATCTCTAT"
    "ACAGGTCATGGACGCAAAACCTTTACTAAAGGAGGCTCTTCAAGCAGCAGTTGGCTTGCCTGTTGACAAG"
    "AAGGTCCCTTTGATTGGCTTCATCGGCAGACTTGAGGAGCAGAAAGGTTCAGATATTCTTGTTGCTGCAA"
    "TTCACAAGTTCATCGGATTGGATGTTCAAATTGTAGTCCTTGTAAGTACCAAATGGACTCATGGTATCTC"
    "TCTTGTTGAGTTTACTTGTGCCGAAACTGAAATTGACCTGCTACTCATCCTATGCATCAGGGAACTGGCA"
    "AAAAGGAGTTTGAGCAGGAGATTGAACAGCTCGAAGTGTTGTACCCTAACAAAGCTAAAGGAGTGGCAAA"
    "ATTCAATGTCCCTTTGGCTCACATGATCACTGCTGGTGCTGATTTTATGTTGGTTCCAAGTAGATTTGAA"
    "CCTTGTGGTCTCATTCAGTTACATGCTATGCGATATGGAACAGTAAGAACCATAAGAGCTTGTACCTTTT"
    "TACTGATTTTTAAAAAAAGAATCATAAGACCTTGTTTTCCGTCTAAAGTTTAATAGCCAACTAAATGTTA"
    "CTGCAGCAAGCTTTTCATTTCTGAAAATTGGTTATCTGATTTTAACATAATCACATGTGAGTCAGGTGCC"
    "AATCTGTGCATCGACTGGTGGACTTGTTGACACTGTGAAAGAAGGCTATACTGGATTCCATATGGGAGCC"
    "TTCAATGTTGAAGTATGTGATTTTACATCAATTGTGTACTTGTACATAGTCCATTCTCGTCTTGATATAC"
    "CCCTTGTTGCATAAACATTAACTTATTGCTTCTTGAATTTGGTTAGTGCGATGTTGTTGACCCAGCTGAT"
    "GTGCTTAAGATAGTAACAACAGTTGCTAGAGCTCTTGCAGTCTATGGCACCCTTGCGTTTGCTGAGATGA"
    "TAAAAAATTGCATGTCAGAGGAGCTCTCCTGGAAGGTAGGTGTCAATTTGATAATTTGCGTAGGTACTTC"
    "AGTTTGTTGTTCTCGTCAGCACTGATGGATGCCAACTGGTGTTCATGCAGGAACCTGCCAAGAAATGGGA"
    "GACATTGCTATTGGGCTTAGGAGCTTCTGGCAGTGAACCCGGTGTTGAAGGGGAAGAAATCGCTCCACTT"
    "GCCAAGGAAAATGTAGCCACTCCCTAAATGAGCTTTGGTTATCCTTGTTTCAACAATAAGATCATTAAGC"
    "AAACGTATTTACTAGCGAACTATGTAGAACCCTATTATGGGGTCTCAATCATCTACAAAATGATTGGTTT"
    "TTGCTGGGGAGCAGCAGCATATTAGGCTGTAAAATCCTGGTTAATGTTTTTGTAGGTAAGGGCTATTTAA"
    "GGTGGTGTGGATCAAAGTCAATAGAAAATAGTTATTACTAGCGTTTGCAACTAAATACTTAGTAATGTAG"
    "CATAAATAATACTAGTAGCTAATATATATGCGTGAATTTGTTGTACCTTTTCTTGCATAATTATTTGCAG"
    "TACATATATAATGAAAATTACCCAAGGAATCAATGTTTCTTGCTCCGTCCTCCTTTGATGATTTTTTACT"
    "CAATACAGAGCTAGTGTGTTAAGTTATAAATTTTGTTTAAAAGAAGTAATCAATTTCAAATTAGTTGGTT"
    "GGTCATATGAAAGAAGCTGGCAGGCTAACTTTGAGGAGATGGCTATTGAATTTCAAAGTGATTATGTGAA"
    "AACAATGCAACATCTATGTCAATCAACACTTAAATTATTGCATTTAGAAAGATATTTTTGATCCCATGAC"
    "ACATTCATTCATAAAGTAAGGTAGTATGTATGATTGAA"
)
REF_ID = "X83220.1"
REF_LEN = len(REFSEQ)

# DNA base ASCII indices in Evo 2's byte-level vocab (512 tokens)
BASE_IDX = {"A": 65, "C": 67, "G": 71, "T": 84}


def call_evo2(sequence, num_tokens=1):
    """Call NVIDIA NIM Evo 2 API and return response with logits."""
    payload = json.dumps({
        "sequence": sequence,
        "num_tokens": num_tokens,
        "top_k": 4,
        "temperature": 1.0,
        "enable_logits": True,
        "random_seed": 42,
    }).encode()

    req = urllib.request.Request(
        NIM_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {NVIDIA_API_KEY}",
        },
    )
    resp = urllib.request.urlopen(req, timeout=60)
    return json.loads(resp.read())


def logits_to_probs(logits_row):
    """Extract DNA base log-probabilities from a logits row (vocab size 512)."""
    # Softmax over the 4 DNA bases only (renormalize)
    base_logits = {b: logits_row[i] for b, i in BASE_IDX.items()}
    max_val = max(base_logits.values())
    exp_vals = {b: math.exp(v - max_val) for b, v in base_logits.items()}
    total = sum(exp_vals.values())
    probs = {b: v / total for b, v in exp_vals.items()}
    log_probs = {b: math.log(p) for b, p in probs.items()}
    return probs, log_probs


def apply_mutation(seq, kind, pos, alt):
    """Apply a mutation (1-indexed pos) and return the mutant sequence."""
    i = pos - 1
    if kind == "snv":
        if alt not in "ACGT":
            raise ValueError("alt must be A, C, G, or T")
        return seq[:i] + alt + seq[i + 1:]
    if kind == "del":
        return seq[:i] + seq[i + 1:]
    raise ValueError(f"Unsupported kind: {kind}")


def score_mutation(kind, pos, alt, window=512):
    """Score a single mutation by comparing model predictions at the mutation site."""
    if pos < 1 or pos > REF_LEN:
        raise ValueError(f"pos must be 1..{REF_LEN}")

    ref_base = REFSEQ[pos - 1]

    # Extract prefix: sequence up to (but not including) the mutation position
    half = window // 2
    start = max(0, pos - 1 - half)
    prefix = REFSEQ[start:pos - 1]

    if len(prefix) < 10:
        raise ValueError("Position too close to start for reliable scoring")

    # Call NIM to predict what comes next after the prefix
    result = call_evo2(prefix, num_tokens=1)

    # Parse logits — shape [num_tokens, 512]
    logits = result.get("logits", [])
    if not logits or not logits[0]:
        raise RuntimeError("No logits returned from NIM API")

    logits_row = logits[0]  # first (and only) generated token
    probs, log_probs = logits_to_probs(logits_row)

    if kind == "snv":
        ref_logprob = log_probs[ref_base]
        alt_logprob = log_probs[alt]
        delta = alt_logprob - ref_logprob  # negative = disruptive
        return {
            "reference_id": REF_ID,
            "reference_length": REF_LEN,
            "mutation": {"kind": "snv", "pos": pos, "ref": ref_base, "alt": alt},
            "probabilities": {b: round(p, 6) for b, p in probs.items()},
            "ref_log_prob": round(ref_logprob, 4),
            "alt_log_prob": round(alt_logprob, 4),
            "delta_score": round(delta, 4),
            "interpretation": (
                "disruptive" if delta < -1.0
                else "suspicious" if delta < -0.3
                else "neutral" if delta < 0.3
                else "favorable"
            ),
        }

    if kind == "del":
        # For deletion: compare P(deleted base) — if model expects this base,
        # deleting it is disruptive
        deleted_base_prob = probs[ref_base]
        deleted_base_logprob = log_probs[ref_base]
        # Score: how confident was the model that this base should be here?
        # High confidence (close to 1.0) = deletion is very disruptive
        return {
            "reference_id": REF_ID,
            "reference_length": REF_LEN,
            "mutation": {"kind": "del", "pos": pos, "ref": ref_base, "alt": None},
            "probabilities": {b: round(p, 6) for b, p in probs.items()},
            "deleted_base_prob": round(deleted_base_prob, 6),
            "deleted_base_log_prob": round(deleted_base_logprob, 4),
            "delta_score": round(-deleted_base_logprob, 4),  # positive = disruptive
            "interpretation": (
                "disruptive" if deleted_base_prob > 0.5
                else "suspicious" if deleted_base_prob > 0.25
                else "neutral"
            ),
        }

    raise ValueError(f"Unsupported kind: {kind}")


def lambda_handler(event, context):
    """Lambda handler for API Gateway v2 (HTTP API)."""
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")

    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Content-Type": "application/json",
    }

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": headers}

    path = event.get("rawPath", "")

    # GET /health
    if method == "GET" and path.endswith("/health"):
        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({
                "ok": True,
                "model": "evo2_7b (NVIDIA NIM)",
                "reference_id": REF_ID,
                "reference_length": REF_LEN,
            }),
        }

    # GET /sequence — return reference info
    if method == "GET" and path.endswith("/sequence"):
        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({
                "id": REF_ID,
                "name": "S.tuberosum GBSS gene (granule-bound starch synthase)",
                "length": REF_LEN,
                "description": (
                    "Potato GBSS gene — disrupting this gene produces amylose-free "
                    "(waxy) starch. The historical 'amf' allele is a single-base "
                    "deletion causing a frameshift."
                ),
                "first_100bp": REFSEQ[:100],
            }),
        }

    # POST /score — score a single mutation
    if method == "POST" and path.endswith("/score"):
        try:
            body = json.loads(event.get("body", "{}"))
            kind = body.get("kind", "snv")
            pos = body.get("pos")
            alt = body.get("alt")
            window = body.get("window", 512)

            if pos is None:
                return {
                    "statusCode": 400,
                    "headers": headers,
                    "body": json.dumps({"error": "pos is required"}),
                }

            result = score_mutation(kind, int(pos), alt, int(window))
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps(result),
            }
        except Exception as e:
            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"error": str(e)}),
            }

    # POST /scan — scan a region for mutation hotspots
    if method == "POST" and path.endswith("/scan"):
        try:
            body = json.loads(event.get("body", "{}"))
            start = int(body.get("start", 1))
            end = int(body.get("end", min(start + 49, REF_LEN)))
            step = int(body.get("step", 1))
            window = int(body.get("window", 512))

            if end - start > 200:
                return {
                    "statusCode": 400,
                    "headers": headers,
                    "body": json.dumps({
                        "error": "Max scan range is 200 positions"
                    }),
                }

            results = []
            for p in range(start, end + 1, step):
                ref_base = REFSEQ[p - 1]
                # Try all 3 possible SNVs at this position
                for alt in "ACGT":
                    if alt == ref_base:
                        continue
                    try:
                        r = score_mutation("snv", p, alt, window)
                        results.append(r)
                    except Exception as e:
                        results.append({
                            "pos": p,
                            "alt": alt,
                            "error": str(e),
                        })

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({"results": results}),
            }
        except Exception as e:
            return {
                "statusCode": 500,
                "headers": headers,
                "body": json.dumps({"error": str(e)}),
            }

    return {
        "statusCode": 404,
        "headers": headers,
        "body": json.dumps({
            "error": "Not found",
            "endpoints": [
                "GET /health",
                "GET /sequence",
                "POST /score {kind, pos, alt, window}",
                "POST /scan {start, end, step, window}",
            ],
        }),
    }
