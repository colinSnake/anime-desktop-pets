const movie = document.querySelector('#movie');
let finished = false;
// Same-document signals are only consumed by this window; no preload/IPC.
const signal = state => { window.location.hash = state; };
function finish(state) {
  if (finished) return;
  finished = true;
  movie.pause();
  signal(state);
}
movie.addEventListener('playing', () => { if (!finished) signal('playing'); }, { once: true });
movie.addEventListener('ended', () => finish('finished'), { once: true });
movie.addEventListener('error', () => finish('failed'), { once: true });
document.querySelector('#skip').addEventListener('click', () => finish('skipped'));
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' || (event.metaKey && event.key === '.')) {
    event.preventDefault();
    finish('skipped');
  }
});
void movie.play().catch(() => finish('failed'));
