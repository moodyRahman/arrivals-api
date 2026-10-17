#!/usr/bin/env python3
"""Scrape canvas PNG snapshots from a directory-listing server, upscale them
(nearest-neighbour, so pixels stay crisp) and collate them into a GIF.

Requires: pip install pillow
Usage:    python scrape_gif.py [--url URL] [--scale 20] [--duration 300] [--out out.gif]
"""
import argparse
import io
import re
import urllib.request
from pathlib import Path
from urllib.parse import unquote, urljoin

from PIL import Image, ImageDraw


def fetch(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return r.read()


def list_pngs(url):
    html = fetch(url).decode("utf-8", "replace")
    names = re.findall(r'href="([^"]+\.png)"', html, re.I)
    return sorted(set(names))  # timestamped names sort chronologically


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default="http://vm-lab:8080/")
    ap.add_argument("--scale", type=int, default=20, help="integer upscale factor")
    ap.add_argument("--duration", type=int, default=300, help="ms per frame")
    ap.add_argument("--out", default="canvas.gif")
    ap.add_argument("--dir", default="frames", help="where to cache downloaded PNGs")
    ap.add_argument("--labels", action="store_true", help="stamp filename timestamp on frames")
    args = ap.parse_args()

    cache = Path(args.dir)
    cache.mkdir(exist_ok=True)

    names = list_pngs(args.url)
    print(f"found {len(names)} PNGs")

    frames = []
    for name in names:
        local = cache / unquote(name)
        if not local.exists():
            local.write_bytes(fetch(urljoin(args.url, name)))
        img = Image.open(io.BytesIO(local.read_bytes())).convert("RGB")
        img = img.resize((img.width * args.scale, img.height * args.scale), Image.NEAREST)
        if args.labels:
            ts = re.search(r"T(\d{2})-(\d{2})-(\d{2})", name)
            ImageDraw.Draw(img).text((4, 4), ":".join(ts.groups()) if ts else name, fill=(255, 255, 0))
        frames.append(img)

    frames[0].save(
        args.out,
        save_all=True,
        append_images=frames[1:],
        duration=args.duration,
        loop=0,
        optimize=False,
    )
    print(f"wrote {args.out}: {len(frames)} frames, {frames[0].size[0]}x{frames[0].size[1]}")


if __name__ == "__main__":
    main()
