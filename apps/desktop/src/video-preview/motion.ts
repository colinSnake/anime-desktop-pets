export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Sample extends Point { time: number }

export function clampPosition(point: Point, size: Size, area: Point & Size): Point {
  return {
    x: Math.round(Math.min(Math.max(point.x, area.x), area.x + Math.max(0, area.width - size.width))),
    y: Math.round(Math.min(Math.max(point.y, area.y), area.y + Math.max(0, area.height - size.height))),
  };
}
