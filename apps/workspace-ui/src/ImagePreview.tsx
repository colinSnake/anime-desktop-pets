import { useLayoutEffect, useRef, useState } from 'react';
import { useDialogDismiss } from './DialogDismiss.tsx';
import { PetNookIcon } from './PetNookIcon.tsx';
import { imagePreviewSize, maxPreviewZoom, minPreviewZoom, nextPreviewZoom } from './image-preview-layout.ts';

type ImagePreviewProps = {
  /** The caller supplies a trusted, display-ready image, never a URL taken from message text. */
  src: string;
  alt: string;
  downloadName?: string;
  returnFocus?: HTMLElement;
  onDismiss(): void;
};

function isPreviewBlank(event: { target: EventTarget; clientX: number; clientY: number }) {
  const { target } = event;
  if (!(target instanceof HTMLElement) || target.closest('[data-image-preview-surface]')) return false;
  if (target.classList.contains('image-preview-scroll')) {
    // The platform scrollbars are controls, not part of the dismissible backdrop.
    const rect = target.getBoundingClientRect();
    if (event.clientX >= rect.left + target.clientWidth || event.clientY >= rect.top + target.clientHeight) return false;
  }
  return true;
}

/** Mount while open. Keep it inside the workspace so the native top layer retains its theme. */
export function ImagePreview(props: ImagePreviewProps) {
  return <PreviewDialog key={props.src} {...props} />;
}

function PreviewDialog({ src, alt, downloadName, returnFocus, onDismiss }: ImagePreviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState<{ width: number; height: number }>();
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const size = image && imagePreviewSize(image, available, zoom);
  const canPan = !!size && (size.width > available.width || size.height > available.height);
  const dismiss = useDialogDismiss(onDismiss, false, onDismiss, isPreviewBlank);

  useLayoutEffect(() => {
    const node = dialog.current, scroll = viewport.current;
    if (!node || !scroll) return;
    const opener = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    const measure = () => {
      const { width, height } = scroll.getBoundingClientRect();
      // Account for the fixed padding around the scroll frame, not dynamic scrollbars.
      const next = { width: Math.floor(width - 32), height: Math.floor(height - 8) };
      setAvailable(old => old.width === next.width && old.height === next.height ? old : next);
    };
    node.showModal();
    close.current?.focus();
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => {
      observer.disconnect();
      node.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  useLayoutEffect(() => {
    const scroll = viewport.current;
    if (scroll) scroll.scrollTo((scroll.scrollWidth - scroll.clientWidth) / 2, (scroll.scrollHeight - scroll.clientHeight) / 2);
  }, [size?.width, size?.height]);

  const changeZoom = (direction: -1 | 0 | 1) => setZoom(value => nextPreviewZoom(value, direction));
  return <dialog ref={dialog} className="image-preview" aria-label={`图片预览：${alt}`} {...dismiss}
    onKeyDown={event => {
      if (!size || event.metaKey || event.ctrlKey || event.altKey) return;
      const direction = event.key === '+' || event.key === '=' ? 1 : event.key === '-' ? -1 : event.key === '0' ? 0 : undefined;
      if (direction === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      changeZoom(direction);
    }}>
    <div className="image-preview-scroll" ref={viewport} tabIndex={canPan ? 0 : undefined} aria-label={canPan ? '图片滚动区域' : undefined} role={canPan ? 'region' : undefined}>
      <div className="image-preview-frame">
        {!failed && <img src={src} alt={alt} draggable={false} decoding="async" hidden={!size} data-image-preview-surface="" data-pannable={canPan || undefined}
          width={size?.width} height={size?.height} onLoad={event => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
            if (width && height) setImage({ width, height }); else setFailed(true);
          }} onError={() => { setImage(undefined); setFailed(true); }}
          onPointerDown={event => {
            if (!canPan || event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary || !viewport.current) return;
            const { scrollLeft: left, scrollTop: top } = viewport.current;
            pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left, top };
            event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={event => {
            const start = pan.current;
            if (start?.id === event.pointerId) viewport.current?.scrollTo(start.left + start.x - event.clientX, start.top + start.y - event.clientY);
          }} onLostPointerCapture={() => { pan.current = null; }} />}
        {(failed || !size) && <p className="image-preview-status" role="status" data-image-preview-surface="">{failed ? '图片无法加载' : '正在加载图片…'}</p>}
      </div>
    </div>
    <div className="image-preview-actions" data-image-preview-surface="">
      {size && downloadName && <a className="image-preview-control" href={src} download={downloadName} aria-label="下载图片" title="下载图片"><PetNookIcon name="download" /></a>}
      <button ref={close} type="button" className="image-preview-control" onClick={onDismiss} aria-label="关闭预览" title="关闭预览 (Esc)"><PetNookIcon name="close" /></button>
    </div>
    <div className="image-preview-zoom" role="group" aria-label="图片缩放" data-image-preview-surface="">
      <button className="image-preview-control" type="button" onClick={() => changeZoom(-1)} disabled={!size || zoom === minPreviewZoom} aria-label="缩小图片" title="缩小图片 (-)"><PetNookIcon name="minus" /></button>
      <button className="image-preview-percent" type="button" onClick={() => changeZoom(0)} disabled={!size} aria-label="适合窗口" title="适合窗口 (0)">
        <span aria-live="polite">{size ? `${size.percent}%` : '—'}</span>
      </button>
      <button className="image-preview-control" type="button" onClick={() => changeZoom(1)} disabled={!size || zoom === maxPreviewZoom} aria-label="放大图片" title="放大图片 (+)"><PetNookIcon name="plus" /></button>
    </div>
  </dialog>;
}
