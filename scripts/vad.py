#!/usr/bin/env python3
import argparse
import json
import sys

import webrtcvad


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--aggressiveness", type=int, default=2)
    args = parser.parse_args()
    pcm = sys.stdin.buffer.read()
    vad = webrtcvad.Vad(args.aggressiveness)
    frame_ms = 30
    frame_bytes = int(args.sample_rate * frame_ms / 1000) * 2
    voiced = []
    for offset in range(0, len(pcm) - frame_bytes + 1, frame_bytes):
        voiced.append(vad.is_speech(pcm[offset:offset + frame_bytes], args.sample_rate))

    intervals = []
    start = None
    hangover = 6
    for index in range(len(voiced) + hangover):
        neighborhood = voiced[max(0, index - 2):min(len(voiced), index + 3)]
        active = sum(neighborhood) >= 2 if neighborhood else False
        if active and start is None:
            start = index
        if start is not None and not active:
            recent = voiced[max(0, index - hangover):min(len(voiced), index)]
            if not any(recent):
                end = max(start + 1, index - hangover + 1)
                if end - start >= 3:
                    intervals.append({"startMs": start * frame_ms, "endMs": end * frame_ms})
                start = None
    if start is not None:
        intervals.append({"startMs": start * frame_ms, "endMs": len(voiced) * frame_ms})
    print(json.dumps({"intervals": intervals}))


if __name__ == "__main__":
    main()
