type Action = 'start' | 'authorize';

/** One synchronous call per trusted hardware or accessibility input, observed in the isolated world. */
export class MicrophoneGesture {
  private observed?: { action: Action; event: Event };
  constructor(target: Pick<Window, 'addEventListener'>) {
    const observe = (event: Event) => {
      this.observed = undefined;
      if (!event.isTrusted) return;
      const button = event.composedPath().find(node => node instanceof HTMLButtonElement);
      if (!(button instanceof HTMLButtonElement) || button.disabled) return;
      const action = button.dataset.microphoneAction;
      if (action === 'authorize' && event.type === 'click') this.observed = { action, event };
      if (action !== 'start') return;
      const pointer = event.type === 'pointerdown' && (event as PointerEvent).isPrimary && (event as PointerEvent).button === 0;
      const keyboard = event.type === 'keydown' && !(event as KeyboardEvent).repeat && [' ', 'Enter'].includes((event as KeyboardEvent).key);
      const accessibility = event.type === 'click' && (event as MouseEvent).detail === 0;
      if (pointer || keyboard || accessibility) this.observed = { action, event };
    };
    for (const type of ['pointerdown', 'keydown', 'click']) target.addEventListener(type, observe, true);
  }
  take(action: Action): boolean {
    const current = this.observed;
    this.observed = undefined;
    return !!current && current.action === action && current.event.eventPhase !== 0;
  }
}
