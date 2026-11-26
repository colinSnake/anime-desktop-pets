type Dimensions = { width: number; height: number };
export const minPreviewZoom = 0.25;
export const maxPreviewZoom = 4;

export function nextPreviewZoom(zoom: number, direction: -1 | 0 | 1) {
  return direction === 0 ? 1 : Math.min(maxPreviewZoom, Math.max(minPreviewZoom, zoom + direction * 0.25));
}

export function imagePreviewSize(image: Dimensions, available: Dimensions, zoom: number) {
  if (!image.width || !image.height || available.width <= 0 || available.height <= 0) return;
  const pixelScale = Math.min(1, available.width / image.width, available.height / image.height) * zoom;
  return {
    width: Math.max(1, Math.floor(image.width * pixelScale)),
    height: Math.max(1, Math.floor(image.height * pixelScale)),
    percent: Math.max(1, Math.round(pixelScale * 100)),
  };
}
