#!/usr/bin/env python3
"""Cut the paper-texture background out of a window of each agent persona's
300-frame scroll sequence (apps/web/public/agents/<role>/frame-NNN.jpg),
producing alpha-matted WebP frames for the interactive crew-figure UI
(apps/web/public/agents-cutout/<role>/fNNN.webp).

Regenerate with: python3 scripts/cutout-agent-frames.py
Requires: pillow, numpy, scipy (pip install pillow numpy scipy).

The frame window per role was picked by hand — scanning each 300-frame
sequence for a window with a real gesture arc (rest -> reaction), not just
grabbing frames 1-40. See the WINDOWS table below.
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, grey_erosion, label
from scipy.ndimage import sum as ndi_sum

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = REPO_ROOT / "apps/web/public/agents"
DST_ROOT = REPO_ROOT / "apps/web/public/agents-cutout"

# (source frame start, step, count) — start/step chosen so the window covers
# a real pose transition found by inspection, not just the sequence's first
# N frames.
WINDOWS = {
    "director": (1, 1, 40),          # raises the megaphone toward camera
    "writer": (110, 2, 40),          # rises from hunched ground-writing to a calm stand
    "cinematographer": (140, 2, 40),  # lifts the handheld camera to eye level
    "composer": (1, 1, 40),          # baton-twirl performance
    "editor": (140, 2, 40),          # scissors open into a snip, then close
}


def cutout(src_path: Path, near: float = 58, far: float = 100) -> Image.Image:
    img = Image.open(src_path).convert("RGB")
    arr = np.asarray(img).astype(np.float32)
    patch = 24
    corners = np.concatenate([
        arr[:patch, :patch].reshape(-1, 3),
        arr[:patch, -patch:].reshape(-1, 3),
        arr[-patch:, :patch].reshape(-1, 3),
        arr[-patch:, -patch:].reshape(-1, 3),
    ])
    bg = corners.mean(axis=0)

    dist = np.linalg.norm(arr - bg, axis=2)
    alpha = np.clip((dist - near) / (far - near), 0, 1)

    # Eat the outer fringe ring (JPEG compression smears background into the
    # line art at the edge) before it survives as a translucent halo.
    alpha = grey_erosion(alpha, size=(3, 3))
    alpha = gaussian_filter(alpha, sigma=0.6)
    alpha[alpha < 0.06] = 0

    # Drop isolated paper-grain specks that survive thresholding but aren't
    # part of the character's silhouette.
    labeled, n = label(alpha > 0.06)
    if n > 0:
        sizes = ndi_sum(alpha > 0.06, labeled, index=range(1, n + 1))
        sizes_by_label = np.zeros(n + 1)
        sizes_by_label[1:] = sizes
        alpha = np.where(sizes_by_label[labeled] > 25, alpha, 0)

    # Un-mix the background color bled into semi-transparent edge pixels
    # (matting decontaminate) so edges don't carry a light fringe.
    safe_alpha = np.clip(alpha, 0.12, 1.0)[..., None]
    fg = np.clip((arr - (1 - safe_alpha) * bg[None, None, :]) / safe_alpha, 0, 255)

    out = Image.fromarray(fg.astype(np.uint8), mode="RGB").convert("RGBA")
    out.putalpha(Image.fromarray((alpha * 255).astype(np.uint8), mode="L"))
    return out


def main() -> None:
    for role, (start, step, count) in WINDOWS.items():
        dst_dir = DST_ROOT / role
        dst_dir.mkdir(parents=True, exist_ok=True)
        for i in range(count):
            src_idx = start + i * step
            src = SRC_ROOT / role / f"frame-{src_idx:03d}.jpg"
            dst = dst_dir / f"f{i + 1:03d}.webp"
            cutout(src).save(dst, "WEBP", quality=88, method=6)
        print(f"{role}: {count} frames -> {dst_dir}")


if __name__ == "__main__":
    main()
