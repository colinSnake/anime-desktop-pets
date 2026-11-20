import { registerHistory, createEmptyHistoryState } from '@lexical/history';
import { registerPlainText } from '@lexical/plain-text';
import { mergeRegister } from '@lexical/utils';
import {
  $addUpdateTag, $createParagraphNode, $createRangeSelection, $createTextNode, $getRoot, $getSelection,
  $isElementNode, $isRangeSelection, $isTextNode, $setSelection, COMMAND_PRIORITY_CRITICAL, COPY_COMMAND, createEditor,
  CUT_COMMAND, HISTORY_PUSH_TAG, PASTE_COMMAND, SKIP_DOM_SELECTION_TAG, type LexicalNode, type PointType,
} from 'lexical';
import { useLayoutEffect, useRef, useState, type KeyboardEventHandler, type RefObject } from 'react';
import { acceptedDraft, chatDraftLimit, sameDraft, type ChatDraft } from './chat-draft.ts';

const modelUpdate = 'chat-draft-sync';
const $readText = () => $getRoot().getChildren().map(block => block.getTextContent()).join('\n');

function $readOffset(point: PointType, limit: number): number {
  const root = $getRoot();
  let node = point.getNode();
  let offset = point.offset;
  if (point.type === 'element' && $isElementNode(node)) {
    offset = node.getChildren().slice(0, offset).reduce((total, child) => total + child.getTextContentSize() + (node === root ? 1 : 0), 0);
  }
  for (let parent = node.getParent(); parent; parent = parent.getParent()) {
    offset += node.getPreviousSiblings().reduce((total, sibling) => total + sibling.getTextContentSize() + (parent === root ? 1 : 0), 0);
    node = parent;
  }
  return Math.min(offset, limit);
}
function $selectOffsets(saved: ChatDraft['selection']) {
  const range = $createRangeSelection();
  const seek = (point: PointType, offset: number, parent: LexicalNode) => {
    if ($isTextNode(parent)) { point.set(parent.getKey(), Math.min(offset, parent.getTextContentSize()), 'text'); return; }
    if (!$isElementNode(parent)) return;
    const children = parent.getChildren();
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      const size = child.getTextContentSize();
      if (offset <= size) {
        if ($isElementNode(child) || $isTextNode(child)) seek(point, offset, child);
        else point.set(parent.getKey(), index + (offset ? 1 : 0), 'element');
        return;
      }
      offset -= size + (parent === $getRoot() ? 1 : 0);
    }
    point.set(parent.getKey(), children.length, 'element');
  };
  seek(range.anchor, saved.anchor, $getRoot());
  seek(range.focus, saved.focus, $getRoot());
  $setSelection(range);
}
function $writeDraft(draft: ChatDraft) {
  const root = $getRoot(); root.clear();
  for (const line of draft.text.split('\n')) {
    const paragraph = $createParagraphNode();
    if (line) paragraph.append($createTextNode(line));
    root.append(paragraph);
  }
  $selectOffsets(draft.selection);
}

export function ChatDraftEditor({ input, hidden, draft, editable, placeholder, invalid, describedBy, onDraft, onTrouble, onKeyDown, onCompose }: {
  input: RefObject<HTMLDivElement | null>; hidden: boolean; draft: ChatDraft; editable: boolean; placeholder: string; invalid: boolean; describedBy: string;
  onDraft(value: ChatDraft): boolean; onTrouble(value: 'limit' | 'broken' | ''): void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>; onCompose(active: boolean): void;
}) {
  const callbacks = useRef({ onDraft, onTrouble });
  const initial = useRef(draft), projected = useRef(draft);
  const restoreOnFocus = useRef(true);
  const [editor] = useState(() => createEditor({ namespace: 'pet-chat', onError: () => callbacks.current.onTrouble('broken') }));
  const [broken, setBroken] = useState(false);
  useLayoutEffect(() => { callbacks.current = { onDraft, onTrouble: value => { if (value === 'broken') setBroken(true); onTrouble(value); } }; }, [onDraft, onTrouble]);
  useLayoutEffect(() => {
    const root = input.current;
    const history = createEmptyHistoryState();
    let attached = false;
    const copy = (event: ClipboardEvent | KeyboardEvent | null, cut: boolean) => {
      const selection = $getSelection();
      if (!event || !('clipboardData' in event) || !event.clipboardData || !$isRangeSelection(selection) || selection.isCollapsed()) return false;
      const text = $readText();
      const a = $readOffset(selection.anchor, text.length), b = $readOffset(selection.focus, text.length);
      event.preventDefault();
      event.clipboardData.setData('text/plain', text.slice(Math.min(a, b), Math.max(a, b)));
      if (cut && editor.isEditable()) { $addUpdateTag(HISTORY_PUSH_TAG); selection.removeText(); }
      return true;
    };
    const stop = mergeRegister(
      registerPlainText(editor), registerHistory(editor, history, 500, Date.now, undefined, 80),
      editor.registerCommand(COPY_COMMAND, event => copy(event, false), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(CUT_COMMAND, event => copy(event, true), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(PASTE_COMMAND, event => {
        if (!('clipboardData' in event) || !event.clipboardData) return false;
        const selection = $getSelection();
        event.preventDefault();
        if (!editor.isEditable() || !$isRangeSelection(selection) || [...event.clipboardData.items].some(item => item.kind === 'file')) return true;
        const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
        if (!text) return true; // No files or HTML nodes are created by paste.
        const length = $readText().length;
        const replaced = Math.abs($readOffset(selection.anchor, length) - $readOffset(selection.focus, length));
        if (length - replaced + text.length > chatDraftLimit) { callbacks.current.onTrouble('limit'); return true; }
        $addUpdateTag(HISTORY_PUSH_TAG); selection.insertRawText(text);
        return true;
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerUpdateListener(({ editorState, tags }) => {
        if (!attached) return; // Lexical commits an empty root during binding, before restoring the pet draft.
        if (tags.has(modelUpdate)) { history.undoStack.length = 0; history.redoStack.length = 0; return; }
        const value = editorState.read(() => {
          const text = $readText(), selection = $getSelection();
          return { text, selection: $isRangeSelection(selection)
            ? { anchor: $readOffset(selection.anchor, text.length), focus: $readOffset(selection.focus, text.length) }
            : projected.current.text === text ? projected.current.selection : { anchor: text.length, focus: text.length } };
        });
        if (sameDraft(value, projected.current)) return;
        if (!acceptedDraft(value)) {
          editor.update(() => $writeDraft(projected.current), { tag: modelUpdate });
          callbacks.current.onTrouble('limit');
          return;
        }
        const textChanged = value.text !== projected.current.text;
        if (callbacks.current.onDraft(value)) {
          projected.current = value;
          if (textChanged) callbacks.current.onTrouble('');
        }
      }),
    );
    editor.setRootElement(root);
    projected.current = initial.current;
    editor.update(() => $writeDraft(initial.current), { discrete: true, tag: [modelUpdate, SKIP_DOM_SELECTION_TAG] });
    attached = true;
    return () => { stop(); editor.setRootElement(null); };
  }, [editor, input]);
  useLayoutEffect(() => { if (hidden) restoreOnFocus.current = true; }, [hidden]);
  useLayoutEffect(() => { editor.setEditable(editable && !broken); }, [editor, editable, broken]);
  useLayoutEffect(() => {
    if (sameDraft(projected.current, draft)) return;
    projected.current = draft;
    const focused = input.current?.ownerDocument.activeElement === input.current;
    restoreOnFocus.current = !focused;
    editor.update(() => $writeDraft(draft), { discrete: true, tag: focused ? modelUpdate : [modelUpdate, SKIP_DOM_SELECTION_TAG] });
  }, [draft, editor, input]);
  return <div ref={input} className="chat-draft-editor" role="textbox" aria-label="聊天消息" aria-multiline="true" aria-placeholder={placeholder}
    aria-invalid={invalid} aria-describedby={describedBy} aria-readonly={!editable || broken ? true : undefined}
    contentEditable={editable && !broken} suppressContentEditableWarning data-empty={!draft.text} data-placeholder={placeholder}
    onPointerDown={() => { restoreOnFocus.current = false; }} onFocus={() => {
      if (!restoreOnFocus.current) return;
      restoreOnFocus.current = false; editor.update(() => $selectOffsets(projected.current.selection));
    }} onKeyDownCapture={onKeyDown} onDropCapture={event => { event.preventDefault(); event.stopPropagation(); }}
    onCompositionStart={() => onCompose(true)} onCompositionEnd={() => onCompose(false)} />;
}
