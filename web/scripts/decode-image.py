#!/usr/bin/env python3
"""Decode an image to a raw RGBA blob the headless harness can read.

Output format (.rgba): b'RGBA' + u32le width + u32le height + raw RGBA bytes (row-major, top row first).
Run isolated: python3 -I scripts/decode-image.py IN OUT
"""
import struct
import sys

from PIL import Image, ImageOps


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: decode-image.py IN OUT.rgba")
    src, dst = sys.argv[1], sys.argv[2]
    im = ImageOps.exif_transpose(Image.open(src))  # honour phone EXIF rotation
    im = im.convert("RGBA")
    w, h = im.size
    with open(dst, "wb") as f:
        f.write(b"RGBA")
        f.write(struct.pack("<II", w, h))
        f.write(im.tobytes())
    print(f"{src}: {w}x{h} -> {dst}")


if __name__ == "__main__":
    main()
