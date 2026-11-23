import type { PackageReference } from '../../../packages/contracts/src/pets.ts';
import { PetCover } from './PetCover.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';
import type { ChatTurn } from './chat-session.ts';

const formatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const replyTimestamp = (time: number, format = formatter): string => format.format(new Date(time));

export function ChatAvatar({ reference }: { reference?: PackageReference }) {
 return <span className="chat-avatar"><PetCover reference={reference} avatar /></span>;
}
export function ChatMessage({ turn, name, reference }: { turn: ChatTurn; name: string; reference?: PackageReference }) {
 const timestamp = replyTimestamp(turn.createdAt);
 return <article className={`chat-message chat-message-${turn.role}`} data-turn-id={turn.id} aria-label={turn.role === 'assistant' ? turn.localOnly ? '本机资料回复' : '助手回复' : '你的消息'}>
  {turn.role === 'assistant' ? <><ChatAvatar reference={reference} /><div className="chat-reply">
   <div className="chat-message-meta"><strong>{name}</strong>{turn.localOnly && <span className="chat-local-label"><PetNookIcon name="lock" />本机资料</span>}
    <time dateTime={new Date(turn.createdAt).toISOString()} aria-label={`回复时间 ${timestamp}`} title={timestamp}>{timestamp.slice(0, 5)}</time>
   </div><div className="chat-bubble">{turn.text}</div>
  </div></> : <div className="chat-bubble">{turn.text}</div>}
 </article>;
}
