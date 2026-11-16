#!/usr/bin/env python3
r"""显式批准后验收合成语音往返；默认静音，永不使用麦克风，不自动重试。

示例（主任务先创建共享私有账本；每次使用新的报告目录）：
  python3 scripts/accept-pet-speech-roundtrip.py \
    --approved-model-requests 12 --ledger /ABS/REPO/.local/acceptance/ledger.json \
    --host-executable /ABS/REPO/apps/companion-macos/.build/debug/PetCompanion \
    --output-directory /ABS/REPO/.local/acceptance/speech-run-01 \
    --allow-speaker-output

宿主 --acceptance-reply 拥有预算预留、无工具单请求和 Coordinator 隔离；
脚本不创建/重置/修改账本、不读取私人配置、聊天、记忆或参考录音。
只有宿主从正常 Runtime/Keychain 读取当前模型设置。报告不保存原始 stderr、
未知协议正文或未经校验的模型输出。物理麦克风和主观听感始终标记为未验证。
"""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import selectors
import socket
import stat
import subprocess
import time
import unicodedata
import wave


ROOT = Path(__file__).resolve().parents[1]
PROMPT = '请用一句话告诉我，二加三等于几。'
REFERENCE_TEXT = '这是一段合成的语音参考，只用于桌宠语音验收。'
MAX_REQUESTS = 12
MAX_LINE = 8192
SAFE_REASONS = {
    'model_load_failed', 'output_device_failed', 'transcription_failed',
    'empty_transcription', 'synthesis_failed', 'playback_failed',
    'invalid_command', 'invalid_json', 'command_too_large', 'invalid_encoding',
    'pet_busy', 'invalid_event', 'event_too_large',
}


class AcceptanceError(Exception):
    """只传递固定错误码，不传递可能含凭证/私人路径的异常正文。"""

    def __init__(self, code, reason=None):
        super().__init__(code)
        self.code = code
        self.reason = reason


@dataclass
class Config:
    root: Path
    output: Path
    ledger: Path
    host: Path
    approved_model_requests: int
    allow_speaker_output: bool = False
    presentation_directory: Path | None = None
    timeout: float = 180.0
    shutdown_timeout: float = 3.0


def finite_timeout(value):
    try:
        result = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError('timeout 必须为有限正数') from None
    if not math.isfinite(result) or not 0 < result <= 900:
        raise argparse.ArgumentTypeError('timeout 必须在 (0, 900] 秒内')
    return result


def argument_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output-directory', dest='output', required=True, type=Path,
                        help='必须为绝对路径且尚不存在；父目录必须已存在')
    parser.add_argument('--ledger', required=True, type=Path,
                        help='主任务已创建的仓库 .local 内共享账本绝对路径（本用户 0600 普通文件）')
    parser.add_argument('--approved-model-requests', required=True, type=int, choices=[MAX_REQUESTS],
                        help='批准的是共享账本总上限，不是本次新增额度；本次最多一次请求')
    parser.add_argument('--host-executable', dest='host', required=True, type=Path,
                        help='已经接入 --acceptance-reply 的 PetCompanion 可执行文件')
    parser.add_argument('--allow-speaker-output', action='store_true',
                        help='显式允许默认扬声器；省略时仍真实合成 TTS，但仅静音排空')
    parser.add_argument('--presentation-directory', type=Path,
                        help='可选：已有宿主状态目录，只发送一次 speech-presentation.sock 呈现请求')
    parser.add_argument('--timeout', type=finite_timeout, default=180.0,
                        help='每阶段截止秒数，失败/超时不重试（默认 180）')
    return parser


def validate_config(config):
    if type(config.approved_model_requests) is not int or config.approved_model_requests != MAX_REQUESTS:
        raise AcceptanceError('approval_required')
    if not math.isfinite(config.timeout) or not 0 < config.timeout <= 900:
        raise AcceptanceError('invalid_timeout')
    if not math.isfinite(config.shutdown_timeout) or not 0 < config.shutdown_timeout <= 10:
        raise AcceptanceError('invalid_timeout')
    if not config.output.is_absolute() or not config.output.parent.is_dir():
        raise AcceptanceError('invalid_output_directory')
    if config.output.exists() or config.output.is_symlink():
        raise AcceptanceError('output_directory_not_new')
    local = config.root / '.local'
    if not config.ledger.is_absolute() or local.is_symlink():
        raise AcceptanceError('invalid_ledger')
    try:
        relative = config.ledger.relative_to(local)
        if '..' in relative.parts:
            raise ValueError()
        # 不跟随账本或 .local 下祖先的链接；也不打开账本正文。
        current = local
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError()
        info = config.ledger.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ValueError()
    except (OSError, ValueError):
        raise AcceptanceError('invalid_ledger') from None
    if not config.host.is_absolute() or not config.host.is_file() or not os.access(config.host, os.X_OK):
        raise AcceptanceError('invalid_host_executable')
    if config.presentation_directory is not None and not config.presentation_directory.is_absolute():
        raise AcceptanceError('invalid_presentation_directory')


def compact(text):
    return ''.join(char for char in unicodedata.normalize('NFKC', text)
                   if not char.isspace() and unicodedata.category(char)[0] != 'P')


def bounded_text(text, maximum):
    return (isinstance(text, str) and 0 < len(text) <= maximum
            and not any(unicodedata.category(char).startswith('C') for char in text))


def checked_transcription(text):
    if not bounded_text(text, 120):
        raise AcceptanceError('asr_mismatch')
    normalized = compact(text).replace('2', '二').replace('3', '三').replace('+', '加')
    if normalized != compact(PROMPT):
        raise AcceptanceError('asr_mismatch')
    return text  # 原始 ASR 文本送到 CLI；不得用常量替换或重试。


def checked_reply(text):
    if not bounded_text(text, 100):
        raise AcceptanceError('reply_mismatch')
    normalized = unicodedata.normalize('NFKC', text)
    # 容许人格化语气/称呼，但拒绝否定、疑问、不同数字和 55/5.5 等伪答案。
    if re.search(r'不|非|没|否|错|吗|么|几|[?？]', normalized):
        raise AcceptanceError('reply_mismatch')
    normalized = re.sub(r'([五5])\s*(?:\(\s*[五5]\s*\)|[，,]?\s*也就是\s*[五5])', r'\1', normalized)
    numeral_map = {'二': 2, '2': 2, '三': 3, '3': 3, '五': 5, '5': 5}
    numerals = re.findall(r'\d+|[零〇一二两三四五六七八九十百千万亿]+', normalized)
    values = [numeral_map.get(token) for token in numerals]
    if values not in ([5], [2, 3, 5]):
        raise AcceptanceError('reply_mismatch')
    if values == [2, 3, 5]:
        equation = compact(normalized).replace('2', '二').replace('3', '三').replace('5', '五')
        equation = equation.replace('的结果', '')
        if not re.search(r'二(?:加|\+)三(?:当然|就是|自然|肯定)?(?:等于|是|为|=)五', equation):
            raise AcceptanceError('reply_mismatch')
    assertion = compact(normalized).replace('=', '等于')
    if not (re.search(r'(?:等于|是|为|答案|结果)[五5]', assertion) or re.match(r'^[五5]', assertion)):
        raise AcceptanceError('reply_mismatch')
    return text


def child_environment(config, *, model=False, transcription=None):
    # 白名单而非复制继承：清除 PET/CODEX/凭证、代理、PYTHONPATH 和私人根目录覆盖。
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8',
           'PYTHONIOENCODING': 'utf-8', 'PYTHONUNBUFFERED': '1',
           'TMPDIR': str(config.output / 'tmp')}
    if model:
        # 不设置 PET_DATA_DIR；CLI 只从默认 Runtime 加载模型设置和 Keychain，
        # 然后自己在 ledger.parent/speech-routing-state 内隔离 Coordinator。
        for key in ('HOME', 'USER', 'LOGNAME'):
            if key in os.environ:
                env[key] = os.environ[key]
        env.update(PET_ACCEPTANCE_TEXT=transcription,
                   PET_ACCEPTANCE_LEDGER=str(config.ledger),
                   PET_ACCEPTANCE_APPROVED_MAX_REQUESTS=str(MAX_REQUESTS))
    else:
        env.update(HOME=str(config.output / 'speech-home'),
                   HF_HOME=str(config.output / 'speech-home' / 'cache'),
                   HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    return env


class OwnedChild:
    """有界读取/等待，仅回收本脚本 Popen 创建的进程，不查杀外部进程。"""

    def __init__(self, name, command, config, env, *, capture=True):
        self.name = name
        self.grace = config.shutdown_timeout
        self.process = subprocess.Popen(
            [str(part) for part in command], cwd=config.root, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, bufsize=0,
        )
        self.buffer = bytearray()
        self.total = 0
        self.eof = False
        self.info = {'name': name, 'shutdown': 'not_closed', 'returncode': None}
        if capture:
            os.set_blocking(self.process.stdout.fileno(), False)

    def send(self, payload):
        encoded = json.dumps(payload, ensure_ascii=False).encode('utf-8') + b'\n'
        if len(encoded) > MAX_LINE:
            raise AcceptanceError('command_too_large')
        try:
            self.process.stdin.write(encoded)
            self.process.stdin.flush()
        except (OSError, ValueError):
            raise AcceptanceError('child_input_closed') from None

    def fill(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AcceptanceError('stage_timeout')
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(remaining):
                raise AcceptanceError('stage_timeout')
            block = os.read(self.process.stdout.fileno(), 4096)
        if not block:
            self.eof = True
            return
        self.total += len(block)
        if self.total > 65536:
            raise AcceptanceError('child_output_too_large')
        self.buffer.extend(block)

    def event(self, deadline):
        while b'\n' not in self.buffer:
            if self.eof:
                raise AcceptanceError('runtime_eof')
            if len(self.buffer) > MAX_LINE:
                raise AcceptanceError('child_output_too_large')
            self.fill(deadline)
        line, _, remainder = self.buffer.partition(b'\n')
        self.buffer = bytearray(remainder)
        if len(line) > MAX_LINE:
            raise AcceptanceError('child_output_too_large')
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError, RecursionError):
            raise AcceptanceError('invalid_runtime_json') from None
        if (not isinstance(event, dict) or type(event.get('protocol_version')) is not int
                or event['protocol_version'] != 1):
            raise AcceptanceError('invalid_runtime_protocol')
        if event.get('type') == 'error' or (event.get('type') == 'session' and event.get('state') == 'error'):
            reason = event.get('reason')
            raise AcceptanceError('runtime_error', reason if isinstance(reason, str) and reason in SAFE_REASONS else 'unrecognized_reason')
        return event

    def document(self, deadline):
        while not self.eof:
            self.fill(deadline)
            if len(self.buffer) > 16384:
                raise AcceptanceError('child_output_too_large')
        self.wait(deadline)
        if self.process.returncode != 0:
            raise AcceptanceError('model_exit_nonzero')
        try:
            document = json.loads(self.buffer)
        except (ValueError, UnicodeError, RecursionError):
            raise AcceptanceError('invalid_model_json') from None
        if not isinstance(document, dict):
            raise AcceptanceError('invalid_model_json')
        return document

    def wait(self, deadline):
        try:
            return self.process.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise AcceptanceError('stage_timeout') from None

    def finish_service(self):
        self.send({'type': 'shutdown'})
        self.process.stdin.close()
        deadline = time.monotonic() + self.grace
        while not self.eof:
            self.fill(deadline)
        # idle 之后的异常/多余事件不能被进程正常退出掩盖。
        if self.buffer.strip():
            raise AcceptanceError('unexpected_runtime_after_idle')
        self.wait(deadline)

    def close(self, *, service=False):
        if self.info['shutdown'] != 'not_closed':
            return self.info
        action = 'exited'
        if self.process.poll() is None:
            action = 'shutdown' if service else 'stdin_closed'
            if service and not self.process.stdin.closed:
                try:
                    self.send({'type': 'shutdown'})
                except AcceptanceError:
                    pass
        try:
            self.process.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            self.process.wait(timeout=self.grace)
        except subprocess.TimeoutExpired:
            action = 'terminate'
            try:
                self.process.terminate()
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=self.grace)
            except subprocess.TimeoutExpired:
                action = 'kill'
                try:
                    self.process.kill()
                except ProcessLookupError:
                    pass
                try:
                    self.process.wait(timeout=self.grace)
                except subprocess.TimeoutExpired:
                    action = 'kill_timeout'
        if self.process.stdout is not None:
            self.process.stdout.close()
        self.info.update(shutdown=action, returncode=self.process.poll())
        return self.info


def validate_wav(path):
    try:
        with wave.open(str(path), 'rb') as audio:
            if (audio.getnchannels() != 1 or audio.getsampwidth() != 2
                    or audio.getframerate() != 24000 or audio.getcomptype() != 'NONE'
                    or not 0 < audio.getnframes() <= 24000 * 30):
                raise ValueError()
            if len(audio.readframes(audio.getnframes())) != audio.getnframes() * 2:
                raise ValueError()
    except (OSError, EOFError, wave.Error, ValueError):
        raise AcceptanceError('invalid_synthetic_wav') from None


def generate_audio(config, mark):
    for name, text in (('prompt', PROMPT), ('reference', REFERENCE_TEXT)):
        aiff = config.output / f'synthetic-{name}.aiff'
        wav = config.output / f'synthetic-{name}.wav'
        commands = [
            ('say', ['/usr/bin/say', '-v', 'Tingting', '-o', aiff, text]),
            ('afconvert', ['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', aiff, wav]),
        ]
        for utility, command in commands:
            label = f'{name}_{utility}'
            mark(label + '_started')
            child = OwnedChild(label, command, config, child_environment(config), capture=False)
            try:
                if child.wait(time.monotonic() + config.timeout) != 0:
                    raise AcceptanceError('synthetic_audio_generation_failed')
            finally:
                mark('child_closed', child=child.close())
            mark(label + '_completed')
        validate_wav(wav)
    mark('synthetic_audio_prepared')


def build_runtime_command(config):
    model_root = config.root / '.local/voice-runtime/models'
    command = [str(config.root / '.local/voice-runtime/venv/bin/python'),
               str(config.root / 'apps/speech-runtime/stdio_service.py'),
               '--asr-model', str(model_root / 'Qwen3-ASR-0.6B-8bit'),
               '--tts-model', str(model_root / 'Qwen3-TTS-12Hz-0.6B-Base-8bit'),
               '--reference-audio', str(config.output / 'synthetic-reference.wav'),
               '--reference-text', REFERENCE_TEXT]
    if config.allow_speaker_output:
        command.append('--allow-speaker-output')
    return command


def present_reply(directory, text, timeout):
    result = {'attempted': True, 'accepted': None}
    try:
        info = directory.lstat()
        path = directory / 'speech-presentation.sock'
        socket_info = path.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o700
                or not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != os.getuid()
                or stat.S_IMODE(socket_info.st_mode) != 0o600 or len(os.fsencode(path)) >= 104):
            raise AcceptanceError('presentation_unavailable')
        # 一次连接、一次发送、无 probe、无重试。超时未知时不伪报 rejected。
        deadline = time.monotonic() + min(timeout, 2.0)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(max(.001, deadline - time.monotonic()))
            connection.connect(str(path))
            connection.sendall(json.dumps({'protocolVersion': 1, 'type': 'display_reply',
                                           'createdAt': time.time(), 'text': text}, ensure_ascii=False).encode() + b'\n')
            response = bytearray()
            while b'\n' not in response:
                connection.settimeout(max(.001, deadline - time.monotonic()))
                block = connection.recv(4096)
                if not block or len(response) + len(block) > 4096:
                    raise AcceptanceError('invalid_presentation_response')
                response.extend(block)
            line, _, extra = response.partition(b'\n')
            value = json.loads(line)
            if (extra or not isinstance(value, dict) or set(value) != {'ok', 'reason'}
                    or type(value.get('ok')) is not bool
                    or (value['ok'] and value['reason'] is not None)
                    or (value['reason'] is not None and not isinstance(value['reason'], str))):
                raise AcceptanceError('invalid_presentation_response')
            reason = value['reason']
            result.update(accepted=value['ok'], reason=(reason if reason in SAFE_REASONS else
                                                      'unrecognized_reason') if reason is not None else None)
    except AcceptanceError as error:
        result['error'] = error.code
    except (OSError, ValueError, UnicodeError, RecursionError):
        result['error'] = 'presentation_unavailable_or_invalid'
    return result


def run_acceptance(config, *, prepare_audio=generate_audio, runtime_command=None, model_command=None):
    """命令替换与音频准备仅供 Python 离线测试注入，CLI 不提供假运行时开关。"""
    started = time.monotonic()
    report = {
        'protocolVersion': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
        'status': 'failed', 'synthetic_prompt': PROMPT, 'synthetic_reference_text': REFERENCE_TEXT,
        'approved_model_requests': MAX_REQUESTS, 'model_invocations': 0, 'ledgerAttempts': None,
        'events': [], 'timings_seconds': {}, 'children': [],
        'presentation': {'attempted': False, 'accepted': None},
        'verification': {'physical_microphone': False, 'subjective_listening': False,
                         'speaker_output': False, 'silent_tts_drain': False},
        'scope': 'synthetic_asr_model_tts_speaker' if config.allow_speaker_output else 'synthetic_asr_model_tts_silent',
        'limitations': ['未验证物理麦克风', '未验证主观听感', '未验证真实桌面矩阵'],
        'model_contract': 'CLI reserves shared max12 ledger before exactly one no-tools Coordinator request; no retry',
    }
    children = []
    output_created = False
    stage = 'preflight'
    since = started

    def mark(marker, **fields):
        if 'child' in fields:
            report['children'].append(fields.pop('child'))
        report['events'].append({'marker': marker, 'elapsed_seconds': round(time.monotonic() - started, 6), **fields})

    def timing(name, since):
        report['timings_seconds'][name] = round(time.monotonic() - since, 6)

    try:
        validate_config(config)
        config.output.mkdir(mode=0o700)
        output_created = True
        for name in ('tmp', 'speech-home'):
            (config.output / name).mkdir(mode=0o700)
        if runtime_command is None:
            runtime_command = build_runtime_command(config)
            if (not Path(runtime_command[0]).is_file()
                    or not Path(runtime_command[1]).is_file()
                    or not all(Path(runtime_command[index]).is_dir() for index in (3, 5))):
                raise AcceptanceError('local_speech_runtime_missing')
        stage = 'synthetic_audio'
        since = time.monotonic()
        prepare_audio(config, mark)
        timing(stage, since)
        stage = 'runtime_startup'
        since = time.monotonic()
        runtime = OwnedChild('speech_runtime', runtime_command, config, child_environment(config))
        children.append((runtime, True))
        event = runtime.event(time.monotonic() + config.timeout)
        if event.get('type') != 'ready':
            raise AcceptanceError('expected_runtime_ready')
        mark('runtime_ready')
        timing(stage, since)
        stage = 'asr'
        since = time.monotonic()
        runtime.send({'type': 'transcribe', 'audio_path': str(config.output / 'synthetic-prompt.wav')})
        mark('transcribe_requested')
        event = runtime.event(time.monotonic() + config.timeout)
        if event.get('type') != 'transcription':
            raise AcceptanceError('expected_transcription')
        transcript = checked_transcription(event.get('text'))
        report['transcription'] = transcript
        mark('transcription_validated')
        timing(stage, since)
        stage = 'model'
        since = time.monotonic()
        model = OwnedChild('acceptance_reply', model_command or [config.host, '--acceptance-reply'],
                           config, child_environment(config, model=True, transcription=transcript))
        children.append((model, False))
        report['model_invocations'] += 1
        mark('model_cli_started')
        response = model.document(time.monotonic() + config.timeout)
        attempts = response.get('ledgerAttempts')
        if type(attempts) is not int or not 1 <= attempts <= MAX_REQUESTS:
            raise AcceptanceError('invalid_ledger_attempts')
        report['ledgerAttempts'] = attempts
        reply = checked_reply(response.get('reply'))
        report['reply'] = reply
        mark('model_reply_validated')
        timing(stage, since)
        if config.presentation_directory is not None:
            stage = 'presentation'
            since = time.monotonic()
            report['presentation'] = present_reply(config.presentation_directory, reply, config.timeout)
            mark('presentation_result', accepted=report['presentation']['accepted'])
            timing(stage, since)
        stage = 'tts_and_drain'
        since = time.monotonic()
        deadline = since + config.timeout
        runtime.send({'type': 'respond', 'text': reply, 'speak': True})
        mark('tts_requested')
        for expected in ('reply', 'speaking', 'audio_started', 'idle'):
            event = runtime.event(deadline)
            if (event.get('type') != 'session' or event.get('state') != expected
                    or (expected == 'reply' and event.get('reply') != reply)):
                raise AcceptanceError('unexpected_session_event')
            mark('idle_after_drain' if expected == 'idle' else expected)
        timing(stage, since)
        stage = 'runtime_shutdown'
        since = time.monotonic()
        runtime.finish_service()
        result = runtime.close(service=True)
        if result['returncode'] != 0 or result['shutdown'] not in {'shutdown', 'exited'}:
            raise AcceptanceError('runtime_shutdown_failed')
        mark('runtime_shutdown_completed')
        timing(stage, since)
        report['verification']['speaker_output' if config.allow_speaker_output else 'silent_tts_drain'] = True
        if config.presentation_directory is not None and report['presentation']['accepted'] is not True:
            stage = 'presentation'
            raise AcceptanceError('presentation_not_accepted')
        report['status'] = 'passed'
    except AcceptanceError as error:
        if stage not in report['timings_seconds']:
            timing(stage, since)
        report['error'] = {'stage': stage, 'code': error.code}
        if error.reason is not None:
            report['error']['reason'] = error.reason
        mark('failed')
    except (Exception, KeyboardInterrupt) as error:
        if stage not in report['timings_seconds']:
            timing(stage, since)
        report['error'] = {'stage': stage, 'code': 'interrupted' if isinstance(error, KeyboardInterrupt) else 'local_execution_failed'}
        mark('failed')
    finally:
        for child, service in reversed(children):
            result = child.close(service=service)
            report['children'].append(result)
            if result['returncode'] is None:
                report['status'] = 'failed'
                report.setdefault('error', {'stage': 'cleanup', 'code': 'owned_child_shutdown_timeout'})
        timing('total', started)
        if output_created:
            try:
                fd = os.open(config.output / 'report.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                    json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
                    stream.write('\n')
                    stream.flush()
                    os.fsync(stream.fileno())
            except OSError:
                report['status'] = 'failed'
                report['error'] = {'stage': 'report', 'code': 'report_write_failed'}
    return report


def main(argv=None):
    args = argument_parser().parse_args(argv)
    report = run_acceptance(Config(root=ROOT, **vars(args)))
    # 摘要同样不输出路径、凭证、原始子进程输出或 CLI 多余字段。
    print(json.dumps({'status': report['status'], 'error': report.get('error'),
                      'ledgerAttempts': report['ledgerAttempts'],
                      'physical_microphone': 'not_verified', 'subjective_listening': 'not_verified'},
                     ensure_ascii=False))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
