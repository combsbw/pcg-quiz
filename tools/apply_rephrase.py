#!/usr/bin/env python3
"""
apply_rephrase.py — apply wording patches to the authored question batches,
with guards that make it impossible for a rewording to change a fact.

A patch is {uid: {"stem"?, "explanation"?, "options"?}}. The guards:

  * only stem / explanation / options may be patched — never the answer index,
    page, type, number, or uid
  * an option may change only at a position whose ORIGINAL text cited a
    section number (so "Refer to 5.11" can become "Refer to Poisoning &
    Overdoses", but a dose value can never be touched)
  * the patched question must still have four distinct options
  * every uid must exist

After applying, the validator runs over the affected batches; it errors on any
section number left in a stem.

Usage:
    python3 tools/apply_rephrase.py authoring/rephrase/R1.json --dry-run
    python3 tools/apply_rephrase.py authoring/rephrase/*.json      # for real
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import validate_authored as V  # noqa: E402

ALLOWED = {"stem", "explanation", "options"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("patches", nargs="+")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    content = json.loads((ROOT / "docs" / "data" / "content.json").read_text())
    V._SECTIONS.update(r["number"] for r in content["guidelines"] + content["drugs"])

    src = ROOT / "authoring" / "out"
    work = Path(tempfile.mkdtemp()) / "out" if args.dry_run else src
    if args.dry_run:
        shutil.copytree(src, work)

    batches = {f.name: json.loads(f.read_text(encoding="utf-8"))
               for f in sorted(work.glob("*.json"))}
    where = {}
    for fname, b in batches.items():
        for i, q in enumerate(b["questions"]):
            where[q["uid"]] = (fname, i)

    problems, touched, applied = [], set(), 0
    for pf in args.patches:
        patch = json.loads(Path(pf).read_text(encoding="utf-8"))
        for uid, change in patch.items():
            tag = f"{Path(pf).name}:{uid}"
            if uid not in where:
                problems.append(f"{tag}: no question with this uid")
                continue
            bad = set(change) - ALLOWED
            if bad:
                problems.append(f"{tag}: may not patch {sorted(bad)}")
                continue
            fname, i = where[uid]
            q = batches[fname]["questions"][i]

            if "options" in change:
                new = change["options"]
                if not isinstance(new, list) or len(new) != 4:
                    problems.append(f"{tag}: options must be a list of 4")
                    continue
                ok = True
                for k, (old_o, new_o) in enumerate(zip(q["options"], new)):
                    if old_o != new_o and not V.section_refs(old_o):
                        problems.append(f"{tag}: option {k} changed but did not cite a "
                                        f"section number — {old_o[:40]!r}")
                        ok = False
                if len({o.strip().lower() for o in new}) != 4:
                    problems.append(f"{tag}: options no longer distinct")
                    ok = False
                if not ok:
                    continue

            for k, v in change.items():
                if not isinstance(v, (str, list)) or (isinstance(v, str) and not v.strip()):
                    problems.append(f"{tag}: empty {k}")
                    break
                q[k] = v.strip() if isinstance(v, str) else [o.strip() for o in v]
            else:
                applied += 1
                touched.add(fname)

    for fname in touched:
        (work / fname).write_text(json.dumps(batches[fname], ensure_ascii=False, indent=1),
                                  encoding="utf-8")

    print(f"applied {applied} patches to {len(touched)} batch files"
          f"{' (dry run — originals untouched)' if args.dry_run else ''}")
    for p in problems:
        print("   GUARD  " + p)

    files = [str(work / f) for f in sorted(touched)] or [str(work / f) for f in batches]
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "validate_authored.py"),
                        *files, "--quiet", "--no-grounding"], capture_output=True, text=True)
    lines = [ln for ln in r.stdout.splitlines()
             if "ERROR" in ln or ln.startswith(("OK", "FAIL", "Total"))]
    print("\n".join(lines[-60:]))
    sys.exit(1 if problems or r.returncode else 0)


if __name__ == "__main__":
    main()
