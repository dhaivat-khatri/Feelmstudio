"""Persistent mflux image server. Loads the model once, keeps it (and its warmed-up
Metal kernels) resident, and serves generations over local HTTP — the fixed per-call
cost of a fresh `mflux-generate` process (weight load + shader compilation, ~15-20s)
is what made per-request CLI spawning too slow; this pays it once at startup instead.

Deliberately stdlib-only (http.server) and single-threaded: only one GPU generation
can run at a time on this hardware regardless, so a thread pool would just queue
requests behind the GIL/GPU anyway, not add real concurrency.
"""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from mflux.models.common.config import ModelConfig
from mflux.models.flux.variants.txt2img.flux import Flux1

flux: Flux1 | None = None


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
            self._json(200, {"ok": True})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/generate":
            self._json(404, {"ok": False, "error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
            image = flux.generate_image(
                seed=body.get("seed", 0),
                prompt=body["prompt"],
                num_inference_steps=body.get("steps", 4),
                width=body.get("width", 512),
                height=body.get("height", 512),
            )
            image.save(path=body["output"], overwrite=True)
            self._json(200, {"ok": True})
        except Exception as exc:  # noqa: BLE001 - reported to the caller, not swallowed
            self._json(500, {"ok": False, "error": str(exc)})

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        # Node's startImageServer streams this straight through; keep it terse.
        print(f"[image_server] {format % args}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default="schnell")
    parser.add_argument("--quantize", type=int, default=4)
    args = parser.parse_args()

    global flux
    print(f"[image_server] loading {args.model} (quantize={args.quantize})...", flush=True)
    flux = Flux1(model_config=ModelConfig.from_name(model_name=args.model), quantize=args.quantize)
    print("[image_server] model loaded, warming up...", flush=True)
    # One throwaway generation now, not on the first real request — this is what
    # actually compiles/caches the Metal kernels, the other half of the fixed cost.
    flux.generate_image(seed=0, prompt="a test image", num_inference_steps=1, width=64, height=64)
    print(f"[image_server] warm, listening on 127.0.0.1:{args.port}", flush=True)

    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
