#!/usr/bin/env python3
"""Swift整链测试探针；临时资料、真实本机协议，可选合成素材的真实离屏Qt。"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
from pet_ai_bubbles import PetAIBubbleClient

LOCAL = '固定本地合成文案，不得发送给模型。'
GENERATED = '我在这里陪着你，慢慢来就好。'


def wait_until(predicate, process_events=lambda: None):
    deadline = time.monotonic() + 3
    while not predicate():
        process_events()
        if time.monotonic() >= deadline:
            raise AssertionError('离线Python气泡探针未在期限内完成')
        time.sleep(.002)


class Presentation:
    """真实Pet/Bubble/SpeechCueClient；不使用真实素材，不输出音频或打开麦克风。"""
    def __init__(self, directory, client):
        # 在任何Qt导入前设置Fusion；真实应用的原生样式不受影响。
        os.environ.update(QT_QPA_PLATFORM='offscreen', QT_STYLE_OVERRIDE='Fusion')
        spec = importlib.util.spec_from_file_location('pet_bubble_adapter_fixture', ROOT / 'scripts/test-real-pet-adapter.py')
        self.fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.fixture)
        self.case = self.fixture.RealAdapterTests()
        self.case.setUp()
        try:
            self.window = self.case.start()
            if getattr(self.fixture.APP, '_pet_task_monitor', None) is not None:
                raise AssertionError('隔离探针不允许创建任务跟随monitor')
            self.window.behavior.enabled = False
            self.window.ai_bubbles.close()
            self.window.ai_bubbles = client
            self.window.speech_cue.close()
            from dragon_speech import SpeechCueClient
            self.window.speech_cue = SpeechCueClient(directory)
        except BaseException:
            self.case.tearDown()
            raise
        self.directory = directory
        self.displayed = []

    def choose(self):
        return self.window.behavior._choose_idle_line(LOCAL)

    def show(self, text):
        self.window.say(text)
        self.displayed.append(self.window.bubble.result_view.toPlainText())
        self.window.bubble.flush_speech()
        expected_count = len(self.displayed)

        def received():
            try:
                receipts = json.loads((self.directory / 'probe-speech-receipts.json').read_text())
                return len(receipts) == expected_count
            except (FileNotFoundError, json.JSONDecodeError):
                return False
        wait_until(received, self.fixture.APP.processEvents)

    def close(self):
        self.case.tearDown()


def main():
    directory, scenario = Path(sys.argv[1]), sys.argv[2]
    assert directory.parent == Path('/tmp') and directory.name.startswith('pet-bubble-e2e-')
    assert scenario in ('success', 'failure', 'revoked', 'disabled')
    # 环境白名单之外再做入口断言，避免以后测试装配改变时静默读取真实资料。
    if (os.environ.get('PET_TASK_LEASE') or os.environ.get('BAILONG_ASSETS_DIR')
            or os.environ.get('CODEX_HOME') != str(directory / 'synthetic-codex')
            or os.environ.get('BAILONG_PET_LIBRARY_DIR') != str(directory / 'empty-pet-library')):
        raise AssertionError('离线探针环境未隔离')
    client = PetAIBubbleClient(directory, timeout=2)
    presentation = None
    try:
        if '--qt' in sys.argv[3:]:
            presentation = Presentation(directory, client)
        choose = presentation.choose if presentation else lambda: client.choose('idle', LOCAL)
        show = presentation.show if presentation else lambda text: None
        # 当前事件只用兜底，不等异步生成；下一次同类事件才消费缓存。
        first = choose()
        (directory / 'first-choice-returned').write_text('returned')
        assert first == LOCAL
        show(first)
        if scenario == 'disabled':
            assert client._worker is None and client._last_attempt is None
        else:
            wait_until(lambda: not client._pending)
        unrelated = client.choose('interaction', LOCAL)
        second = choose()
        show(second)
        third = choose()
        show(third)
        assert unrelated == LOCAL
        assert second == (GENERATED if scenario == 'success' else LOCAL)
        assert third == LOCAL
        client.close()
        wait_until(lambda: client._worker is None or not client._worker.is_alive())
        assert client.choose('idle', LOCAL) == LOCAL
        result = dict(selections=[first, unrelated, second, third], workerStopped=True)
        if presentation:
            result['displayed'] = presentation.displayed
            presentation.close()
            presentation = None
        print(json.dumps(result, ensure_ascii=False))
    finally:
        client.close()
        if presentation:
            presentation.close()


if __name__ == '__main__':
    main()
