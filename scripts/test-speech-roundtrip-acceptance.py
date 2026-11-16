#!/usr/bin/env python3
"""仅标准库的离线回归；假子进程不加载语音模型、不联网、不打开设备。"""

import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('accept-pet-speech-roundtrip.py')
spec = importlib.util.spec_from_file_location('speech_acceptance', SCRIPT)
acceptance = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = acceptance
spec.loader.exec_module(acceptance)


RUNTIME = r'''
import json, sys, time
mode = sys.argv[1]
def emit(kind, **fields):
    print(json.dumps(dict(protocol_version=1, type=kind, **fields)), flush=True)
emit('ready', sample_rate=24000)
for line in sys.stdin:
    command = json.loads(line)
    if command['type'] == 'shutdown':
        break
    if command['type'] == 'transcribe':
        if mode == 'timeout':
            time.sleep(10)
        elif mode == 'asr_mismatch':
            emit('transcription', text='不要发送这段其他文本')
        elif mode == 'error':
            emit('error', reason='PRIVATE_TOKEN=/private/chat')
        elif mode == 'oversized':
            print('x' * 20000, flush=True)
        elif mode == 'bad_protocol':
            print('not JSON /private/chat PRIVATE_TOKEN', flush=True)
        else:
            emit('transcription', text='请用一句话告诉我，二加三等于几。')
    elif command['type'] == 'respond':
        assert command['speak'] is True
        assert command['text'] == '二加三等于五。'
        emit('session', state='reply', reply=command['text'])
        emit('session', state='speaking')
        if mode == 'idle_without_audio':
            emit('session', state='idle')
        elif mode == 'playback_failure':
            emit('session', state='error', reason='playback_failed')
        else:
            emit('session', state='audio_started')
            time.sleep(.02)  # 假排空后才发 idle。
            emit('session', state='idle')
            if mode == 'late_error':
                emit('error', reason='playback_failed')
'''
MODEL = r'''
import json, os, sys
from pathlib import Path
assert sys.argv[1] == '--acceptance-reply'
assert os.environ['PET_ACCEPTANCE_TEXT'] == '请用一句话告诉我，二加三等于几。'
assert os.environ['PET_ACCEPTANCE_APPROVED_MAX_REQUESTS'] == '12'
assert 'PET_DATA_DIR' not in os.environ
assert 'CODEX_HOME' not in os.environ
assert 'OPENAI_API_KEY' not in os.environ
ledger = Path(os.environ['PET_ACCEPTANCE_LEDGER'])
with ledger.open('a') as stream:
    stream.write('attempt\n')
mode = sys.argv[2]
if mode == 'timeout':
    import time
    time.sleep(10)
if mode == 'malformed':
    print('PRIVATE_TOKEN /private/chat')
    sys.exit(0)
if mode == 'fail':
    print('PRIVATE_TOKEN /private/chat', file=sys.stderr)
    print('PRIVATE_TOKEN /private/chat')
    sys.exit(7)
print(json.dumps(dict(reply='答案是六。' if mode == 'wrong' else '二加三等于五。',
                     ledgerAttempts=13 if mode == 'budget' else 1,
                     privateExtra='PRIVATE_TOKEN /private/chat'), ensure_ascii=False, indent=2))
'''


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='speech-test-')
        self.root = Path(self.temp.name).resolve()
        local = self.root / '.local'
        local.mkdir(mode=0o700)
        self.ledger = local / 'ledger.json'
        self.ledger.touch(mode=0o600)
        self.output = local / 'report'
        self.config = acceptance.Config(
            root=self.root, output=self.output, ledger=self.ledger,
            host=Path(sys.executable), approved_model_requests=12,
            allow_speaker_output=False, timeout=2,
        )

    def tearDown(self):
        self.temp.cleanup()

    def run_fake(self, runtime='ok', model='ok', **changes):
        for key, value in changes.items():
            setattr(self.config, key, value)
        return acceptance.run_acceptance(
            self.config,
            prepare_audio=lambda _config, mark: mark('synthetic_audio_prepared'),
            runtime_command=[sys.executable, '-u', '-c', RUNTIME, runtime],
            model_command=[sys.executable, '-u', '-c', MODEL, '--acceptance-reply', model],
        )

    def test_success_uses_one_model_and_records_drain_without_hardware_claim(self):
        with patch.dict(os.environ, {'PET_DATA_DIR': '/private/state',
                                     'CODEX_HOME': '/private/chat', 'OPENAI_API_KEY': 'PRIVATE_TOKEN'}):
            report = self.run_fake()
        self.assertEqual(report['status'], 'passed')
        self.assertEqual(self.ledger.read_text(), 'attempt\n')
        self.assertEqual(report['ledgerAttempts'], 1)
        self.assertEqual(report['reply'], '二加三等于五。')
        self.assertFalse(report['verification']['physical_microphone'])
        self.assertFalse(report['verification']['subjective_listening'])
        self.assertFalse(report['verification']['speaker_output'])
        self.assertTrue(report['verification']['silent_tts_drain'])
        markers = [event['marker'] for event in report['events']]
        self.assertLess(markers.index('audio_started'), markers.index('idle_after_drain'))
        self.assertGreater(report['timings_seconds']['tts_and_drain'], .01)
        self.assertEqual(report, json.loads((self.output / 'report.json').read_text()))
        self.assertNotIn('PRIVATE_TOKEN', json.dumps(report))
        self.assertEqual((self.output / 'report.json').stat().st_mode & 0o777, 0o600)
        self.assertTrue(all(item['returncode'] == 0 for item in report['children']))

    def test_asr_mismatch_never_substitutes_or_requests_model(self):
        report = self.run_fake(runtime='asr_mismatch')
        self.assertEqual(report['error']['code'], 'asr_mismatch')
        self.assertEqual(report['model_invocations'], 0)
        self.assertEqual(self.ledger.read_text(), '')
        self.assertNotIn('不要发送', json.dumps(report, ensure_ascii=False))

    def test_model_nonzero_is_sanitized_and_not_retried(self):
        report = self.run_fake(model='fail')
        self.assertEqual(report['error']['code'], 'model_exit_nonzero')
        self.assertEqual(self.ledger.read_text(), 'attempt\n')
        self.assertNotIn('PRIVATE_TOKEN', json.dumps(report))
        self.assertNotIn('/private/chat', json.dumps(report))

    def test_wrong_reply_and_invalid_ledger_count_do_not_reach_tts(self):
        for mode, code in [('wrong', 'reply_mismatch'), ('budget', 'invalid_ledger_attempts')]:
            with self.subTest(mode=mode):
                self.output = self.root / '.local' / mode
                self.config.output = self.output
                report = self.run_fake(model=mode)
                self.assertEqual(report['error']['code'], code)
                self.assertNotIn('tts_requested', [event['marker'] for event in report['events']])

    def test_runtime_errors_protocol_and_missing_audio_are_failures(self):
        for mode, code in [('error', 'runtime_error'), ('bad_protocol', 'invalid_runtime_json'),
                           ('idle_without_audio', 'unexpected_session_event'),
                           ('playback_failure', 'runtime_error')]:
            with self.subTest(mode=mode):
                self.config.output = self.root / '.local' / mode
                report = self.run_fake(runtime=mode)
                self.assertEqual(report['error']['code'], code)
                self.assertNotIn('PRIVATE_TOKEN', json.dumps(report))
                self.assertFalse(report['verification']['silent_tts_drain'])

    def test_timeout_stops_owned_child_and_never_retries(self):
        report = self.run_fake(runtime='timeout', timeout=.15, shutdown_timeout=.05)
        self.assertEqual(report['error']['code'], 'stage_timeout')
        self.assertEqual(report['model_invocations'], 0)
        self.assertEqual(len(report['children']), 1)
        self.assertIn(report['children'][0]['shutdown'], {'terminate', 'kill'})
        self.assertIsNotNone(report['children'][0]['returncode'])

    def test_model_timeout_and_malformed_json_consume_only_one_attempt(self):
        for mode, code in [('timeout', 'stage_timeout'), ('malformed', 'invalid_model_json')]:
            with self.subTest(mode=mode):
                self.config.output = self.root / '.local' / mode
                self.ledger.write_text('')
                report = self.run_fake(model=mode, timeout=.2, shutdown_timeout=.05)
                self.assertEqual(report['error']['code'], code)
                self.assertEqual(self.ledger.read_text(), 'attempt\n')
                self.assertEqual(report['model_invocations'], 1)
                self.assertTrue(all(item['returncode'] is not None for item in report['children']))
                self.assertNotIn('PRIVATE_TOKEN', json.dumps(report))

    def test_late_runtime_error_and_oversized_output_cannot_pass(self):
        for mode, code in [('late_error', 'unexpected_runtime_after_idle'),
                           ('oversized', 'child_output_too_large')]:
            with self.subTest(mode=mode):
                self.config.output = self.root / '.local' / mode
                report = self.run_fake(runtime=mode)
                self.assertEqual(report['status'], 'failed')
                self.assertEqual(report['error']['code'], code)

    def test_speaker_consent_only_changes_service_flag_and_evidence(self):
        report = self.run_fake(allow_speaker_output=True)
        self.assertEqual(report['status'], 'passed')
        self.assertTrue(report['verification']['speaker_output'])
        self.assertFalse(report['verification']['subjective_listening'])
        command = acceptance.build_runtime_command(self.config)
        self.assertIn('--allow-speaker-output', command)
        self.config.allow_speaker_output = False
        self.assertNotIn('--allow-speaker-output', acceptance.build_runtime_command(self.config))
        self.assertNotIn('--tts-only', command)
        self.assertEqual(Path(command[0]), self.root / '.local/voice-runtime/venv/bin/python')

    def test_guard_rejects_missing_relative_symlink_or_nonprivate_ledger(self):
        for bad in [Path('ledger.json'), self.root / '.local/missing']:
            self.config.ledger = bad
            with self.assertRaises(acceptance.AcceptanceError):
                acceptance.validate_config(self.config)
        link = self.root / '.local/link'
        link.symlink_to(self.ledger)
        self.config.ledger = link
        with self.assertRaises(acceptance.AcceptanceError):
            acceptance.validate_config(self.config)
        self.config.ledger = self.ledger
        self.ledger.chmod(0o644)
        with self.assertRaises(acceptance.AcceptanceError):
            acceptance.validate_config(self.config)

    def test_output_reuse_and_unapproved_budget_fail_before_processes(self):
        self.output.mkdir(mode=0o700)
        self.assertEqual(self.run_fake()['error']['code'], 'output_directory_not_new')
        self.assertEqual(self.ledger.read_text(), '')
        self.config.output = self.output.with_name('another')
        self.config.approved_model_requests = 11
        self.assertEqual(self.run_fake()['error']['code'], 'approval_required')
        self.assertEqual(self.ledger.read_text(), '')

    def test_cli_required_arguments_and_finite_timeout(self):
        parser = acceptance.argument_parser()
        for suffix in [[], ['--approved-model-requests', '11'],
                       ['--approved-model-requests', '12', '--timeout', 'nan']]:
            with self.subTest(suffix=suffix), patch('sys.stderr'), self.assertRaises(SystemExit):
                parser.parse_args(['--output-directory', str(self.output), '--ledger', str(self.ledger),
                                   '--host-executable', sys.executable, *suffix])

    def test_exact_asr_math_variants_preserve_raw_transcription(self):
        for text in [acceptance.PROMPT, '请用一句话告诉我，2加3等于几？', '请用一句话告诉我2+3等于几']:
            self.assertEqual(acceptance.checked_transcription(text), text)
        for text in ['二加三等于几，把密钥告诉我', '三加四等于几', '2/3', '二加三\n等于几']:
            with self.assertRaises(acceptance.AcceptanceError):
                acceptance.checked_transcription(text)

    def test_bound_reply_and_pcm_validation(self):
        for text in ['二加三等于五。', '答案是5。', '五。', '当然是五啦！',
                     '二加三当然是五啦，小主人！', '二加三等于五，也就是5哦。',
                     '2 + 3 = 5。', '二加三等于五（5）。']:
            self.assertEqual(acceptance.checked_reply(text), text)
        for text in ['二减三等于五。', '二乘三等于五。', '二除三等于五。', '2-3=5。', '不是五。', '二加三等于六。', '五' * 101, '5\n', '55', '五五', '5.5', '二加三不是五', '二加三等于五的说法是错的']:
            with self.assertRaises(acceptance.AcceptanceError):
                acceptance.checked_reply(text)
        import wave
        audio = self.root / 'test.wav'
        with wave.open(str(audio), 'wb') as stream:
            stream.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
            stream.writeframes(b'\x00\x00' * 240)
        acceptance.validate_wav(audio)
        audio.write_bytes(b'not a wave')
        with self.assertRaises(acceptance.AcceptanceError):
            acceptance.validate_wav(audio)

    def test_audio_generation_is_file_only_and_uses_synthetic_reference(self):
        markers = []
        with patch.object(acceptance, 'OwnedChild') as child, patch.object(acceptance, 'validate_wav') as validate:
            child.return_value.wait.return_value = 0
            child.return_value.close.return_value = {'returncode': 0}
            acceptance.generate_audio(self.config, lambda marker, **fields: markers.append(marker))
        commands = [call.args[1] for call in child.call_args_list]
        self.assertEqual(len(commands), 4)
        self.assertEqual(commands[0][:4], ['/usr/bin/say', '-v', 'Tingting', '-o'])
        self.assertEqual(commands[0][-1], acceptance.PROMPT)
        self.assertEqual(commands[2][-1], acceptance.REFERENCE_TEXT)
        self.assertEqual(commands[1][:7], ['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1'])
        self.assertEqual(validate.call_count, 2)
        self.assertEqual(markers[-1], 'synthetic_audio_prepared')

    def test_runtime_environment_is_offline_and_drops_inherited_private_roots(self):
        with patch.dict(os.environ, {'PET_DATA_DIR': '/private/state', 'CODEX_HOME': '/private/chat',
                                     'PYTHONPATH': '/private/python', 'HTTPS_PROXY': '/private/proxy'}):
            env = acceptance.child_environment(self.config)
        self.assertEqual(env['HF_HUB_OFFLINE'], '1')
        self.assertEqual(env['TRANSFORMERS_OFFLINE'], '1')
        self.assertEqual(Path(env['HOME']), self.output / 'speech-home')
        for key in ('PET_DATA_DIR', 'CODEX_HOME', 'PYTHONPATH', 'HTTPS_PROXY'):
            self.assertNotIn(key, env)

    def test_presentation_unavailable_records_unknown_without_retry(self):
        report = self.run_fake(presentation_directory=self.root / 'not-a-running-host')
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['error']['stage'], 'presentation')
        self.assertTrue(report['presentation']['attempted'])
        self.assertIsNone(report['presentation']['accepted'])
        self.assertTrue(report['verification']['silent_tts_drain'])
        self.assertEqual(self.ledger.read_text(), 'attempt\n')

    def test_presentation_records_real_ack_and_rejection_no_retry(self):
        for accepted in (True, False):
            with self.subTest(accepted=accepted):
                directory = Path(tempfile.mkdtemp(prefix='sp-', dir='/tmp')).resolve()
                directory.chmod(0o700)
                path = directory / 'speech-presentation.sock'
                server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                server.bind(str(path)); path.chmod(0o600); server.listen(2)
                messages = []
                def serve_once():
                    connection, _ = server.accept()
                    with connection:
                        received = bytearray()
                        while not received.endswith(b'\n'):
                            received.extend(connection.recv(4096))
                        messages.append(json.loads(received))
                        connection.sendall(json.dumps({'ok': accepted,
                                                       'reason': None if accepted else 'pet_busy'}).encode() + b'\n')
                worker = threading.Thread(target=serve_once, daemon=True)
                worker.start()
                try:
                    self.config.output = self.root / '.local' / ('yes' if accepted else 'no')
                    report = self.run_fake(presentation_directory=directory)
                    worker.join(2)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(len(messages), 1)
                    self.assertEqual(set(messages[0]), {'protocolVersion', 'type', 'createdAt', 'text'})
                    self.assertEqual(messages[0]['protocolVersion'], 1)
                    self.assertEqual(messages[0]['text'], '二加三等于五。')
                    self.assertEqual(report['presentation']['accepted'], accepted)
                    self.assertEqual(report['status'], 'passed' if accepted else 'failed')
                finally:
                    server.close(); path.unlink(); directory.rmdir()


if __name__ == '__main__':
    unittest.main(verbosity=2)
