#!/usr/bin/env python3
"""Forward-reference lint for setup.sql: no statement may reference a table
created later in the file. Catches the ordering class of bug the isolated
appointments harness could not (policy loops / triggers naming tables that
are created further down)."""
import re, sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()

created = {}   # table -> first create line
for i, ln in enumerate(lines, 1):
    m = re.search(r"create table if not exists public\.(\w+)", ln)
    if m and m.group(1) not in created:
        created[m.group(1)] = i

bad = []
in_fn_body = False   # function bodies resolve at RUNTIME — skip them.
                     # do $$ blocks execute at APPLY time — keep checking those.
for i, ln in enumerate(lines, 1):
    # skip comment-only lines
    s = ln.strip()
    if s.startswith("--"):
        continue
    if not in_fn_body and re.search(r"create (or replace )?function", ln):
        in_fn_body = True
    if in_fn_body:
        if re.search(r"\$\$;\s*$", ln) or s == "$$;":
            in_fn_body = False
        continue
    for t, cl in created.items():
        if i >= cl:
            continue
        # bare-name mention inside a policy/trigger loop array, or public.T reference
        if re.search(rf"public\.{t}\b", ln) or re.search(rf"'{t}'", ln):
            bad.append((i, t, cl, s[:100]))

if bad:
    for i, t, cl, s in bad:
        print(f"line {i}: references {t} (created at {cl}): {s}")
    sys.exit(1)
print(f"OK {path}: no forward references ({len(created)} tables)")
