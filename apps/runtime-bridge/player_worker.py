"""Private Qt worker. Bootstrap first; no Qt or legacy imports before validation."""
import os
from pathlib import Path
import queue
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent))
from player_protocol import bubble_speech_event, parse_bootstrap, parse_request, position_event, read_frame, reply, stopped_event


def main():
    output = sys.stdout.buffer
    # Imported prepared code must not write logs into the private protocol.
    sys.stdout = sys.stderr
    bootstrap = parse_bootstrap(read_frame(sys.stdin.buffer))
    if sys.platform != 'darwin' or sys.version_info < (3, 11):
        output.write(reply(bootstrap['id'], 'error')); output.flush()
        return 1
    from player_adapter import PlayerAdapter, isolate_profile
    isolate_profile(bootstrap['config'])
    # Decode the bounded static cover before creating QApplication. Reuse the
    # same prepared-PNG / idle-first-frame policy as workspace thumbnails.
    from pet_cover import thumbnail
    cover_png = thumbnail(bootstrap['config']['assets'])
    # Offscreen callers set Fusion before this module ever imports Qt.
    from PySide6.QtWidgets import QApplication
    from PySide6.QtCore import QTimer
    app = QApplication([])
    app.setQuitOnLastWindowClosed(False)
    if os.environ.get('QT_QPA_PLATFORM') == 'offscreen':
        app.setStyle('Fusion')
    incoming = queue.Queue(maxsize=1)
    eof = threading.Event()
    phase = 'starting'
    stop_id = None
    startup_pending = True

    def bubble_spoken(text):
        if phase != 'running' or eof.is_set():
            return
        try:
            line = bubble_speech_event(text)
        except ValueError:
            return
        try:
            output.write(line); output.flush()
        except (BrokenPipeError, OSError):
            eof.set()

    adapter = PlayerAdapter(bootstrap['config'], cover_png=cover_png, on_speech=bubble_spoken)

    def send(request_id, state):
        try:
            output.write(reply(request_id, state)); output.flush()
        except (BrokenPipeError, OSError):
            eof.set()

    def position_changed(x, y):
        try:
            line = position_event(x, y)
        except ValueError:
            return
        try:
            output.write(line); output.flush()
        except (BrokenPipeError, OSError):
            eof.set()

    def ready():
        nonlocal phase, startup_pending
        if phase != 'starting':
            return
        phase = 'running'; startup_pending = False
        send(bootstrap['id'], phase)

    def stop():
        nonlocal phase
        if phase not in ('stopping', 'stopped'):
            phase = 'stopping'
            adapter.stop()

    def failed():
        nonlocal startup_pending
        if startup_pending:
            send(bootstrap['id'], 'error'); startup_pending = False
        stop()

    def stopped():
        nonlocal phase, startup_pending
        phase = 'stopped'
        if startup_pending:
            send(bootstrap['id'], 'error'); startup_pending = False
        if stop_id:
            send(stop_id, 'stopped')
        else:
            try:
                output.write(stopped_event()); output.flush()
            except (BrokenPipeError, OSError):
                pass
        QTimer.singleShot(0, app.quit)

    def read_input():
        try:
            while not eof.is_set():
                line = read_frame(sys.stdin.buffer)
                if line is None:
                    break
                request = parse_request(line, bootstrap['session'])
                while not eof.is_set():
                    try:
                        incoming.put(request, timeout=.05)
                        break
                    except queue.Full:
                        pass
        except (ValueError, OSError):
            pass
        finally:
            eof.set()

    def poll():
        nonlocal stop_id
        try:
            request = incoming.get_nowait()
        except queue.Empty:
            request = None
        if request:
            if request['command'] == 'status':
                send(request['id'], phase)
            elif request['command'] == 'apply':
                send(request['id'], 'running' if phase == 'running' and adapter.apply_display_preferences(request['preferences']) else 'error')
            elif request['command'] == 'apply-behavior':
                send(request['id'], 'running' if phase == 'running' and adapter.apply_behavior_preferences(request['preferences']) else 'error')
            elif request['command'] == 'task-animation':
                send(request['id'], 'running' if phase == 'running' and not eof.is_set() and adapter.apply_task_animation(request['task']) else 'error')
            elif request['command'] in ('show', 'hide'):
                visible = request['command'] == 'show'
                send(request['id'], 'running' if phase == 'running' and adapter.set_visible(visible) else 'error')
            elif stop_id is None:
                stop_id = request['id']
                stop()
            else:
                # One stop per session; don't let flooding extend shutdown.
                eof.set()
        if eof.is_set() and incoming.empty():
            stop()

    timer = QTimer(app); timer.setInterval(10); timer.timeout.connect(poll)
    adapter.begin(ready, failed, stopped, position_changed)
    threading.Thread(target=read_input, daemon=True).start()
    timer.start()
    return app.exec()


if __name__ == '__main__':
    try:
        code = main()
    except Exception:
        code = 1  # No raw exception, path, account data, or credentials on stdout.
    # A daemon may be blocked in stdin; never wait for its buffered lock at exit.
    os._exit(code)
