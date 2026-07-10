#!/usr/bin/env python3
"""Generate pitch-deck imagery with the Gemini image API.

Runs inside the Deck Art GitHub Action (workflow_dispatch only), where
GEMINI_API_KEY is injected from the repository secret. Writes PNGs to
pitch/art/. Never prints the key or the raw response.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

KEY = os.environ.get("GEMINI_API_KEY", "")
if not KEY:
    print("GEMINI_API_KEY is not set — aborting", file=sys.stderr)
    sys.exit(1)

# Newest first; fall back if a model id isn't available to this key.
MODELS = [
    "gemini-2.5-flash-image",
    "gemini-2.5-flash-image-preview",
]

STYLE = (
    " Muted loden green, dark wood, and brass palette; warm parchment light; "
    "photorealistic film-photography mood; shallow depth of field. "
    "No readable text or lettering anywhere in the image, no logos, no human faces."
)

IMAGES = {
    "counter-unattended": (
        "A small heritage shop interior at dusk with the lights on and nobody behind "
        "the counter: a long dark wooden counter, a brass lamp, a neatly folded "
        "deep loden-green wool blanket resting on it, empty stool." + STYLE
    ),
    "clerk-presenting": (
        "Close crop of a shopkeeper's hands in a wool cardigan presenting a folded "
        "deep-green herringbone wool blanket across a worn wooden counter toward a "
        "customer, warm brass lamplight. Hands only, no faces." + STYLE
    ),
    "ledger-audit": (
        "A cloth-bound merchant's ledger lying open on dark wood beside a brass hand "
        "stamp and a fountain pen, ruled columns left blank, warm low lamplight, "
        "macro composition." + STYLE
    ),
    "lit-shopfronts": (
        "A row of small premium shopfronts on a narrow old-European street at blue "
        "hour, warm golden light glowing from the windows, cobblestones, deep green "
        "facades with brass details, gentle mist." + STYLE
    ),
}

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pitch", "art")
os.makedirs(OUT_DIR, exist_ok=True)


def call(model: str, prompt: str, with_aspect: bool) -> bytes | None:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    cfg: dict = {"responseModalities": ["IMAGE"]}
    if with_aspect:
        cfg["imageConfig"] = {"aspectRatio": "16:9"}
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": cfg,
    }).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "x-goog-api-key": KEY,
    })
    with urllib.request.urlopen(req, timeout=180) as res:
        payload = json.load(res)
    for cand in payload.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            data = part.get("inlineData") or part.get("inline_data") or {}
            if data.get("data"):
                return base64.b64decode(data["data"])
    return None


def generate(name: str, prompt: str) -> bool:
    for model in MODELS:
        for with_aspect in (True, False):
            try:
                png = call(model, prompt, with_aspect)
            except urllib.error.HTTPError as e:
                print(f"{name}: {model} (aspect={with_aspect}) → HTTP {e.code}", file=sys.stderr)
                if e.code in (429, 500, 503):
                    time.sleep(15)
                continue
            except Exception as e:  # noqa: BLE001 — report and try the next combination
                print(f"{name}: {model} → {type(e).__name__}", file=sys.stderr)
                continue
            if png:
                path = os.path.join(OUT_DIR, f"{name}.png")
                with open(path, "wb") as f:
                    f.write(png)
                print(f"{name}: {len(png)//1024} KB via {model} (aspect={with_aspect})")
                return True
            print(f"{name}: {model} returned no image part", file=sys.stderr)
    return False


failures = [n for n, p in IMAGES.items() if not generate(n, p)]
if failures:
    print("failed: " + ", ".join(failures), file=sys.stderr)
    sys.exit(1)
print("all images generated")
