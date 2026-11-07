"""Single-turn async orchestration for a reply-and-speech session."""

import asyncio
import inspect
import time
from dataclasses import dataclass
from typing import AsyncIterable, Callable

from queueing import BoundedMessageQueue, ChatMessage


@dataclass(frozen=True)
class SessionEvent:
    state: str
    reply: str | None = None
    reason: str | None = None


class SpeechSession:
    """Coordinates supplied replies, streaming TTS, player, and UI callbacks."""

    def __init__(
        self,
        queue: BoundedMessageQueue,
        *,
        generate_reply: Callable[[ChatMessage], object],
        synthesize: Callable[[str], AsyncIterable[bytes]],
        play_chunk: Callable[[bytes], object],
        publish: Callable[[SessionEvent], object],
        max_message_age_seconds: float = 30.0,
        max_reply_characters: int = 120,
        clock=time.monotonic,
    ):
        self.queue = queue
        self.generate_reply = generate_reply
        self.synthesize = synthesize
        self.play_chunk = play_chunk
        self.publish = publish
        self.max_message_age_seconds = max_message_age_seconds
        self.max_reply_characters = max_reply_characters
        self.clock = clock

    async def _publish(self, event):
        result = self.publish(event)
        if inspect.isawaitable(result):
            await result

    async def process_next(self):
        message = self.queue.pop()
        if message is None:
            return False
        if self.clock() - message.received_at >= self.max_message_age_seconds:
            await self._publish(SessionEvent("skipped", reason="expired"))
            return True

        failure_reason = "reply_generation_failed"
        try:
            await self._publish(SessionEvent("thinking"))
            reply = self.generate_reply(message)
            if inspect.isawaitable(reply):
                reply = await reply
            reply = " ".join(reply.split())[: self.max_reply_characters] if isinstance(reply, str) else ""
            if not reply:
                await self._publish(SessionEvent("idle", reason="no_reply"))
                return True
            if self.clock() - message.received_at >= self.max_message_age_seconds:
                await self._publish(SessionEvent("skipped", reason="expired"))
                return True
            if not self.queue.try_reserve_reply():
                await self._publish(SessionEvent("skipped", reason="reply_rate_limited"))
                return True

            await self._publish(SessionEvent("reply", reply=reply))
            await self._publish(SessionEvent("speaking"))
            failure_reason = "synthesis_failed"
            chunks = self.synthesize(reply)
            if inspect.isawaitable(chunks):
                chunks = await chunks
            async for chunk in chunks:
                failure_reason = "playback_failed"
                result = self.play_chunk(chunk)
                if inspect.isawaitable(result):
                    await result
                failure_reason = "synthesis_failed"
            await self._publish(SessionEvent("idle"))
        except asyncio.CancelledError:
            await self._publish(SessionEvent("idle", reason="cancelled"))
            raise
        except Exception:
            await self._publish(SessionEvent("error", reason=failure_reason))
        return True
