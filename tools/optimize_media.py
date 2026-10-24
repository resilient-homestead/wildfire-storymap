"""Shrink the story's images to what a screen can actually show.

Camera originals (3024x4032 phone photos, 12,000px panoramas) are far
larger than any display needs. This caps every image data/chapters.json
uses at

    photos        2400px on the long side  (fullscreen viewer on a 1440p
                                            or 2x laptop screen)
    panoramas     3200px wide              (aspect >= 2.5, shown full width)

and re-encodes as WebP: lossy q75 for photos, q90 for text-heavy graphics
(posters, maps, timelines, newspaper clippings). Photos OF signs, placards
or QR posters are still photos - high-quality or lossless encoding of a
photograph made them bigger than the originals in the first dry run - so
the graphic rule matches names of drawn artwork only. PNG/JPEG sources
become .webp and chapters.json is updated to the new names.

Safety:
  - every original is copied to ../media_originals/ (OUTSIDE the repo)
    before it is touched; git history has them too
  - EXIF rotation is applied first, or phone photos come out sideways
  - a result is kept only if it is >=10% smaller (or smaller in pixels)
  - a file whose backup exists and is larger than it has already been
    processed and is skipped: re-encoding lossy output again only loses
    quality

After running: python tools/prerender.py  (index.html + sitemap.xml)

    python tools/optimize_media.py            optimize
    python tools/optimize_media.py --dry-run  report only
"""
import json
import re
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "media"
BACKUP = ROOT.parent / "media_originals"
CHAPTERS = ROOT / "data" / "chapters.json"

PHOTO_MAX = 2400
PANO_MAX_W = 3200
PANO_ASPECT = 2.5
# Text-heavy graphics get a higher quality so lettering stays crisp.
GRAPHIC_HINTS = re.compile(r"graph|map|timeline|poster|flyer|newspaper|badge|logo|"
                           r"debris|safer|prepared|G0\d_|risk|defensible|"
                           r"recovering|rebuild", re.I)
# Lossless only for pure, computer-made line art such as a bare QR code
# image. None of the current files qualify (the QR file is a photo of a
# poster), so this matches nothing; add a name here only after checking.
LOSSLESS_HINTS = re.compile(r"(?!x)x")
EXTS = (".png", ".jpg", ".jpeg", ".webp")


def referenced(doc):
    """media/... image paths used anywhere in chapters.json, in order."""
    found = []

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str):
            for m in re.finditer(r"media/[^\"<>]+?\.(?:png|jpe?g|webp)", v, re.I):
                if m.group(0) not in found:
                    found.append(m.group(0))
    walk(doc)
    return found


def plan_size(w, h):
    if w / h >= PANO_ASPECT:
        return (PANO_MAX_W, round(h * PANO_MAX_W / w)) if w > PANO_MAX_W else (w, h)
    long_side = max(w, h)
    if long_side <= PHOTO_MAX:
        return w, h
    s = PHOTO_MAX / long_side
    return round(w * s), round(h * s)


def main():
    dry = "--dry-run" in sys.argv
    raw = CHAPTERS.read_text(encoding="utf-8")
    refs = referenced(json.loads(raw))
    BACKUP.mkdir(exist_ok=True)
    renames, rows = {}, []
    before_total = after_total = 0

    for ref in refs:
        src = ROOT / ref
        if not src.exists() or src.suffix.lower() not in EXTS:
            rows.append((ref, "MISSING" if not src.exists() else "skip (type)", 0, 0, ""))
            continue
        size0 = src.stat().st_size
        backup = BACKUP / src.name
        if backup.exists() and backup.stat().st_size > size0:
            rows.append((ref, "already done", size0, size0, ""))
            before_total += size0; after_total += size0
            continue

        im = Image.open(src)
        im = ImageOps.exif_transpose(im)
        w, h = im.size
        nw, nh = plan_size(w, h)
        lossless = bool(LOSSLESS_HINTS.search(src.name))
        graphic = lossless or src.suffix.lower() == ".png" or bool(GRAPHIC_HINTS.search(src.name))
        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        im = im.convert("RGBA" if has_alpha else "RGB")
        if (nw, nh) != (w, h):
            im = im.resize((nw, nh), Image.LANCZOS)

        dst = src.with_suffix(".webp")
        if dst != src and dst.exists():
            rows.append((ref, f"CONFLICT: {dst.name} exists", size0, size0, ""))
            continue
        tmp = dst.with_name(dst.stem + ".__tmp__.webp")
        opts = {"lossless": True, "method": 6} if lossless else \
               {"quality": 90 if graphic else 75, "method": 6}
        icc = Image.open(src).info.get("icc_profile")
        if icc:
            opts["icc_profile"] = icc
        im.save(tmp, "WEBP", **opts)
        size1 = tmp.stat().st_size

        kind = "lossless" if lossless else ("graphic q90" if graphic else "photo q75")
        dims = f"{w}x{h} -> {nw}x{nh}" if (nw, nh) != (w, h) else f"{w}x{h}"
        # Smaller in bytes is the point; fewer pixels alone is not a reason
        # to keep a re-encode that came out heavier.
        worth = size1 <= size0 * 0.9
        if dry or not worth:
            tmp.unlink()
            label = ("would: " + kind) if worth else "keep original"
            rows.append((ref, label, size0, size1 if worth else size0, dims))
            before_total += size0; after_total += size1 if (dry and worth) else size0
            continue

        if not backup.exists():
            shutil.copy2(src, backup)
        tmp.replace(dst)
        if dst != src:
            src.unlink()
            renames[ref] = "media/" + dst.name
        rows.append((ref, kind, size0, size1, dims))
        before_total += size0; after_total += size1

    if renames and not dry:
        for old, new in renames.items():
            raw = raw.replace(old, new)
        json.loads(raw)  # still valid
        CHAPTERS.write_text(raw, encoding="utf-8", newline="\n")

    for ref, what, a, b, dims in sorted(rows, key=lambda r: -(r[2] - r[3])):
        pct = f"-{100 - 100 * b / a:4.0f}%" if a and b < a else "     "
        print(f"{a/1024:8.0f} -> {b/1024:6.0f} KB {pct}  {what:22} {dims:24} {ref[6:]}")
    print(f"\n{len(refs)} images referenced; total {before_total/1048576:.1f} MB -> "
          f"{after_total/1048576:.1f} MB"
          + (f"; {len(renames)} renamed in chapters.json" if renames and not dry else "")
          + ("  (dry run - nothing changed)" if dry else ""))
    if renames and not dry:
        print("now run: python tools/prerender.py")


if __name__ == "__main__":
    main()
