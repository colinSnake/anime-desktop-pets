#!/usr/bin/env python3
"""Benchmark local MLX TTS first-chunk latency without recording prompt content."""

import argparse
from datetime import datetime, timezone
import getpass
import json
import math
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time


def command_output(*args):
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def machine_info():
    total_memory = command_output("sysctl", "-n", "hw.memsize")
    disk = shutil.disk_usage(Path.home())
    return {
        "system": platform.system(),
        "macos": platform.mac_ver()[0] or None,
        "release": platform.release(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "cpu": command_output("sysctl", "-n", "machdep.cpu.brand_string"),
        "memory_total_bytes": int(total_memory) if total_memory and total_memory.isdigit() else None,
        "data_volume_free_bytes": disk.free,
    }


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return None
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def doctor():
    info = machine_info()
    info["mlx_audio"] = None
    info["mlx"] = None
    info["metal_device"] = None
    try:
        import mlx.core as mx
        import mlx_audio

        info["mlx_audio"] = getattr(mlx_audio, "__version__", "installed")
        info["mlx"] = getattr(mx, "__version__", "installed")
        info["metal_device"] = str(mx.default_device())
    except Exception as error:  # Report environment failure without importing model code.
        info["import_error"] = type(error).__name__
    print(json.dumps(info, ensure_ascii=False, indent=2))


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doctor", action="store_true", help="Print machine and MLX runtime status")
    parser.add_argument("--model", type=Path, help="Local model directory; remote model IDs are rejected")
    parser.add_argument("--reference-audio", type=Path, help="Authorized local voice sample")
    parser.add_argument("--language", default="chinese")
    parser.add_argument("--streaming-interval", type=float, default=0.5)
    parser.add_argument("--warmups", type=int, default=1, help="Unmeasured generation passes before sampling")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--report", type=Path, help="Optional JSON report path")
    parser.add_argument("--audio-output", type=Path, help="Optional WAV path for listening review")
    return parser.parse_args()


def run_benchmark(args):
    if not args.model or not args.model.is_dir():
        raise SystemExit("--model must point to an already downloaded local directory; downloads are disabled")
    if not args.reference_audio or not args.reference_audio.is_file():
        raise SystemExit("--reference-audio must point to a local audio file")
    reference_text = getpass.getpass("Exact reference transcript (hidden): ")
    text = getpass.getpass("Text to synthesize (hidden): ")
    if not reference_text or not text:
        raise SystemExit("Reference transcript and synthesis text must not be empty")
    if len(text) > 120 or len(reference_text) > 500:
        raise SystemExit("Text limits exceeded (generated text: 120 chars; reference transcript: 500 chars)")
    if not 0.1 <= args.streaming_interval <= 2.0:
        raise SystemExit("--streaming-interval must be between 0.1 and 2.0 seconds")
    if not 1 <= args.repeats <= 20:
        raise SystemExit("--repeats must be between 1 and 20")
    if not 0 <= args.warmups <= 5:
        raise SystemExit("--warmups must be between 0 and 5")

    import mlx.core as mx
    from mlx_audio.audio_io import write as write_audio
    from mlx_audio.tts.utils import load_model

    model_path = args.model.resolve()
    reference_audio = args.reference_audio.resolve()
    output_path = args.audio_output.resolve() if args.audio_output else None

    mx.reset_peak_memory()
    load_started = time.perf_counter()
    model = load_model(str(model_path))
    load_seconds = time.perf_counter() - load_started
    load_peak_memory_bytes = int(mx.get_peak_memory())
    loaded_active_memory_bytes = int(mx.get_active_memory())
    for _ in range(args.warmups):
        for result in model.generate(
            text=text,
            ref_audio=str(reference_audio),
            ref_text=reference_text,
            lang_code=args.language,
            stream=True,
            streaming_interval=args.streaming_interval,
            verbose=False,
        ):
            if int(result.audio.size) > 0:
                mx.eval(result.audio)

    first_chunk_seconds = []
    synthesis_seconds = []
    audio_durations = []
    realtime_factors = []
    peak_memory_bytes = []
    saved_chunks = []
    sample_rate = int(model.sample_rate)

    for index in range(args.repeats):
        mx.reset_peak_memory()
        started = time.perf_counter()
        first_chunk_at = None
        sample_count = 0
        chunks = []
        for result in model.generate(
            text=text,
            ref_audio=str(reference_audio),
            ref_text=reference_text,
            lang_code=args.language,
            stream=True,
            streaming_interval=args.streaming_interval,
            verbose=False,
        ):
            audio = result.audio
            if int(audio.size) == 0:
                continue
            mx.eval(audio)
            if first_chunk_at is None:
                first_chunk_at = time.perf_counter()
                first_chunk_seconds.append(first_chunk_at - started)
            sample_count += int(audio.shape[0])
            chunks.append(audio)

        finished = time.perf_counter()
        if first_chunk_at is None or sample_count == 0:
            raise RuntimeError("TTS returned no audio chunks")
        duration = sample_count / sample_rate
        elapsed = finished - started
        synthesis_seconds.append(elapsed)
        audio_durations.append(duration)
        realtime_factors.append(elapsed / duration if duration else None)
        peak_memory_bytes.append(int(mx.get_peak_memory()))
        if output_path and index == args.repeats - 1:
            saved_chunks = chunks

    if output_path and saved_chunks:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        audio = mx.concatenate(saved_chunks, axis=0) if len(saved_chunks) > 1 else saved_chunks[0]
        write_audio(str(output_path), audio, sample_rate, format="wav")

    report = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "machine": machine_info(),
        "runtime": {
            "mlx_audio": __import__("importlib.metadata", fromlist=["version"]).version("mlx-audio"),
            "mlx": __import__("importlib.metadata", fromlist=["version"]).version("mlx"),
            "device": str(mx.default_device()),
        },
        "model": {
            "local_directory_name": model_path.name,
            "directory_size_bytes": sum(p.stat().st_size for p in model_path.rglob("*") if p.is_file()),
            "load_seconds": load_seconds,
            "load_peak_memory_bytes": load_peak_memory_bytes,
            "active_memory_after_load_bytes": loaded_active_memory_bytes,
        },
        "benchmark": {
            "warmups": args.warmups,
            "repeats": args.repeats,
            "streaming_interval_seconds": args.streaming_interval,
            "reference_audio_duration_not_recorded": True,
            "output_characters": len(text),
            "first_nonempty_chunk_seconds": first_chunk_seconds,
            "first_nonempty_chunk_p50_seconds": percentile(first_chunk_seconds, 0.50),
            "first_nonempty_chunk_p95_seconds": percentile(first_chunk_seconds, 0.95),
            "synthesis_seconds": synthesis_seconds,
            "audio_duration_seconds": audio_durations,
            "real_time_factor": realtime_factors,
            "peak_memory_bytes": peak_memory_bytes,
            "peak_memory_max_bytes": max(peak_memory_bytes),
            "sample_rate": sample_rate,
            "playback_onset_measured": False,
        },
    }
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


def main():
    args = parse_args()
    if args.doctor:
        doctor()
        return 0
    try:
        run_benchmark(args)
    except Exception as error:
        print(f"benchmark failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
