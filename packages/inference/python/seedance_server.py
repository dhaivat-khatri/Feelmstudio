"""Persistent HTTP server for the experimental Seedance-style DiT
(research/seedance-model/model.py — imported from there directly, not
duplicated, so there's one source of truth for the architecture).

UNTRAINED BY DEFAULT: with no --checkpoint, the model has random weights
and /generate produces structured noise, not real images or video. Pass
--checkpoint <path> once you've trained one with
research/seedance-model/train.py. This server exists so OSAI's adapter
layer (packages/inference/src/seedance-adapter.ts) has something real to
talk to while the model itself is still a research artifact — see
packages/inference/README.md.

Mirrors image_server.py's shape: stdlib http.server, single process
(one GPU generation at a time regardless), /health + /generate.
"""

import argparse
import json
import sys
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import torch

MODEL_DIR = Path(__file__).resolve().parents[3] / "research" / "seedance-model"
sys.path.insert(0, str(MODEL_DIR))
from model import ModelConfig, SeedanceStyleDiT, sample_euler  # noqa: E402

model: SeedanceStyleDiT | None = None
cfg: ModelConfig | None = None
device: torch.device | None = None
has_checkpoint = False


def load_reference(path, image_size):
    from PIL import Image
    import numpy as np

    img = Image.open(path).convert("RGB").resize((image_size, image_size))
    t = torch.from_numpy(np.array(img)).float().permute(2, 0, 1) / 127.5 - 1.0
    return t.unsqueeze(0).unsqueeze(0)  # (1, 1, C, H, W)


def tokenize(text, vocab_size, max_len):
    """Same deterministic toy tokenizer as train.py — token ids only need
    to be consistent within one server's lifetime for its own checkpoint."""
    words = text.lower().split() or ["<empty>"]
    ids = [zlib.crc32(w.encode()) % vocab_size for w in words[:max_len]]
    ids += [0] * (max_len - len(ids))
    return torch.tensor([ids], dtype=torch.long)


def save_png(tensor, path):
    from PIL import Image
    import numpy as np

    arr = ((tensor.clamp(-1, 1) + 1) * 127.5).byte().permute(1, 2, 0).cpu().numpy()
    Image.fromarray(arr).save(path)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "trained": has_checkpoint})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/generate":
            self._json(404, {"ok": False, "error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
            modality = body.get("modality", "image")
            num_frames = cfg.num_frames if modality == "video" else 1

            seed = body.get("seed")
            if seed is not None:
                torch.manual_seed(seed)

            tokens = tokenize(body["prompt"], cfg.text_vocab_size, cfg.max_text_len).to(device)

            ref_image = None
            if body.get("referenceImagePath"):
                ref_image = load_reference(body["referenceImagePath"], cfg.image_size).to(device)

            shape = (1, num_frames, cfg.in_channels, cfg.image_size, cfg.image_size)
            sample = sample_euler(
                model, shape, tokens,
                num_steps=body.get("steps", 20), device=device, ref_image=ref_image,
            )

            out_path = Path(body["output"])
            out_path.parent.mkdir(parents=True, exist_ok=True)

            if modality == "image":
                save_png(sample[0, 0], str(out_path))
                self._json(200, {"ok": True})
            else:
                stem = out_path.with_suffix("")
                frame_paths = []
                for i in range(num_frames):
                    p = f"{stem}_frame{i:03d}.png"
                    save_png(sample[0, i], p)
                    frame_paths.append(p)
                self._json(200, {"ok": True, "framePaths": frame_paths})
        except Exception as exc:  # noqa: BLE001 - reported to the caller, not swallowed
            self._json(500, {"ok": False, "error": str(exc)})

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        print(f"[seedance_server] {format % args}", file=sys.stderr)


def main() -> None:
    global model, cfg, device, has_checkpoint

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--checkpoint", default=None)
    parser.add_argument("--dim", type=int, default=256)
    parser.add_argument("--depth", type=int, default=4)
    parser.add_argument("--heads", type=int, default=4)
    parser.add_argument("--patch-size", type=int, default=8)
    parser.add_argument("--image-size", type=int, default=64)
    parser.add_argument("--num-frames", type=int, default=8)
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    if args.device:
        device = torch.device(args.device)
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    elif torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")

    if args.checkpoint:
        # Config comes from the checkpoint itself so shapes always match the
        # trained weights, regardless of what CLI flags were passed here.
        ckpt = torch.load(args.checkpoint, map_location=device)
        cfg = ModelConfig(**ckpt["config"])
        model = SeedanceStyleDiT(cfg).to(device)
        model.load_state_dict(ckpt["model"])
        has_checkpoint = True
        print(f"[seedance_server] loaded checkpoint {args.checkpoint}", flush=True)
    else:
        cfg = ModelConfig(
            dim=args.dim, depth=args.depth, num_heads=args.heads,
            patch_size=args.patch_size, image_size=args.image_size,
            num_frames=args.num_frames,
        )
        model = SeedanceStyleDiT(cfg).to(device)
        print(
            "[seedance_server] WARNING: no --checkpoint given — model is UNTRAINED, "
            "output will be structured noise, not real images/video",
            flush=True,
        )

    model.eval()
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[seedance_server] {n_params:,} params on {device}, listening on 127.0.0.1:{args.port}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
