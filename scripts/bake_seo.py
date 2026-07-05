#!/usr/bin/env python3
"""Bake seo.* CMS overrides into index.html <head> before a Pages publish.

Social link unfurlers (Slack, iMessage, Facebook, X) read raw HTML and do NOT
run JavaScript, so the runtime hydrator can't reach them. This bakes the current
title / description / Open Graph tags straight into the served HTML.

Source of truth is the public ?site=1 endpoint (same data the page hydrates
from), so no database credentials are needed. Best-effort: any failure leaves
index.html untouched and exits 0, so a publish never breaks on this.
"""
import json
import re
import sys
import urllib.request

HTML = "index.html"
html = open(HTML, encoding="utf-8").read()

ep = re.search(r"endpoint:\s*'([^']+)'", html)
key = re.search(r"supabaseAnonKey:\s*'([^']+)'", html)
if not ep:
    print("no endpoint in index.html — skipping SEO bake")
    sys.exit(0)

url = ep.group(1) + ("&site=1" if "?" in ep.group(1) else "?site=1")
req = urllib.request.Request(url)
if key:
    req.add_header("apikey", key.group(1))
    req.add_header("Authorization", "Bearer " + key.group(1))
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        slots = json.load(r).get("slots", {})
except Exception as e:  # noqa: BLE001
    print("?site=1 fetch failed — skipping SEO bake:", e)
    sys.exit(0)


def val(k):
    s = slots.get(k)
    return s.get("value") if s and s.get("value") else None


def esc(v):
    return v.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


changed = False

t = val("seo.title")
if t:
    html, n = re.subn(r"<title>.*?</title>", "<title>" + esc(t) + "</title>", html, count=1, flags=re.S)
    changed = changed or n > 0


def set_meta(attr, name, v):
    global html, changed
    if not v:
        return
    tag = '<meta ' + attr + '="' + name + '" content="' + esc(v) + '">'
    pat = re.compile(r'<meta\s+' + attr + r'=["\']' + re.escape(name) + r'["\'][^>]*>', re.I)
    if pat.search(html):
        html = pat.sub(tag, html, count=1)
    else:
        html = html.replace("</head>", "  " + tag + "\n</head>", 1)
    changed = True


set_meta("name", "description", val("seo.description"))
set_meta("property", "og:title", val("seo.og_title"))
set_meta("property", "og:description", val("seo.og_description"))
set_meta("property", "og:image", val("seo.og_image"))

if changed:
    open(HTML, "w", encoding="utf-8").write(html)
    print("baked SEO overrides into index.html <head>")
else:
    print("no SEO overrides set — index.html unchanged")
