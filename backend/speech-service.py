#!/usr/bin/env python3
"""Local Parakeet v3 speech-to-text service (loopback only).

Listens on 127.0.0.1:4875. POST /transcribe with raw audio bytes
(wav, pcm16, any sample rate; webm/ogg NOT accepted here — the Node
backend converts via ffmpeg first). Returns {"text": "..."}.

Keeps the model resident so dictation doesn't reload it per request.
"""
import io
import json
import os
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from sherpa_onnx import OfflineRecognizer

MODEL_DIR = os.environ.get("MIAOS_SPEECH_MODEL_DIR", "").strip()
if not MODEL_DIR:
    raise RuntimeError("MIAOS_SPEECH_MODEL_DIR is required to start the speech service.")
if not os.path.isdir(MODEL_DIR):
    raise RuntimeError(f"MIAOS_SPEECH_MODEL_DIR does not exist: {MODEL_DIR}")
PORT = 4875

print("loading parakeet v3...", flush=True)
rec = OfflineRecognizer.from_transducer(
    encoder=MODEL_DIR + "/encoder.int8.onnx",
    decoder=MODEL_DIR + "/decoder.int8.onnx",
    joiner=MODEL_DIR + "/joiner.int8.onnx",
    tokens=MODEL_DIR + "/tokens.txt",
    num_threads=4,
    model_type="nemo_transducer",
)
print("parakeet v3 ready", flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/transcribe":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            with wave.open(io.BytesIO(body), "rb") as wav:
                sr = wav.getframerate()
                ch = wav.getnchannels()
                raw = wav.readframes(wav.getnframes())
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if ch > 1:
                samples = samples.reshape(-1, ch).mean(axis=1)
            stream = rec.create_stream()
            stream.accept_waveform(sr, samples)
            rec.decode_stream(stream)
            text = stream.result.text.strip()
        except Exception as exc:  # noqa: BLE001 — return empty, never crash
            print("transcribe error:", exc, flush=True)
            text = ""
        payload = json.dumps({"text": text}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        return


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"speech service on 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
