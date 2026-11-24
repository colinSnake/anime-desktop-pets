import { useRef } from 'react';
import { PetNookIcon } from './PetNookIcon.tsx';

export function ChatMicrophoneButton({ enabled, active, start, stop, cancel }: {
 enabled: boolean; active: boolean; start(): void; stop(): void; cancel(): void;
}) {
 const held = useRef<{ pointer: number } | { key: string } | undefined>(undefined);
 const drop = () => { if (held.current) { held.current = undefined; cancel(); } };
 const dropPointer = (event: { pointerId: number }) => {
  if (held.current && 'pointer' in held.current && held.current.pointer === event.pointerId) drop();
 };
 return <button type="button" className="chat-add chat-microphone" disabled={!enabled && !active} data-microphone-action="start"
  aria-label="按住说话（本机转写）" aria-pressed={active} title="按住说话，松开转写到草稿"
  onPointerDown={event => {
   if (!event.isPrimary || event.button !== 0 || held.current || !enabled) return;
   // Pointer capture guarantees release even if the pointer has left the button.
   event.currentTarget.setPointerCapture(event.pointerId);
   held.current = { pointer: event.pointerId };
   start();
  }} onPointerUp={event => {
   if (held.current && 'pointer' in held.current && held.current.pointer === event.pointerId) {
    held.current = undefined; stop();
   }
  }} onPointerCancel={dropPointer} onLostPointerCapture={dropPointer} onBlur={drop}
  onContextMenu={event => { event.preventDefault(); }}
  onKeyDown={event => {
   if (event.key !== ' ' && event.key !== 'Enter') return;
   event.preventDefault();
   if (event.repeat || held.current) return;
   if (active) { stop(); return; }
   if (enabled) { held.current = { key: event.key }; start(); }
  }} onKeyUp={event => {
   if (event.key !== ' ' && event.key !== 'Enter') return;
   event.preventDefault();
   if (held.current && 'key' in held.current && held.current.key === event.key) {
    held.current = undefined; stop();
   }
  }} onClick={event => {
   // Assistive activation has no pointer press/release pair. Toggle explicitly.
   if (event.detail || held.current) return;
   if (active) stop(); else if (enabled) start();
  }}><PetNookIcon name="speech" /></button>;
}
