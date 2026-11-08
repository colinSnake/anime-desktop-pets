"""Standalone live-message ingestion primitives.

This package deliberately has no dependency on the desktop host, pet helper,
or speech runtime. Platform adapters can feed normalized messages into the
bounded pipeline without coupling platform credentials or network code to the
existing application.
"""

from live_pipeline import GateResult, LivePipeline, PipelineStats
from live_protocol import LiveMessage, decode_command, encode_event

__all__ = [
    "GateResult",
    "LiveMessage",
    "LivePipeline",
    "PipelineStats",
    "decode_command",
    "encode_event",
]
