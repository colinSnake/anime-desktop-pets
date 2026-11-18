"""仅使用临时子进程的协议测试；不导入 Qt、不读取真实产品数据。"""
import json
import pathlib
import subprocess
import sys
import unittest

WORKER = pathlib.Path(__file__).with_name('worker.py')


class WorkerTests(unittest.TestCase):
    def run_worker(self, text):
        result = subprocess.run([sys.executable, '-I', str(WORKER)], input=text, text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, '')
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_probe_and_shutdown_are_versioned(self):
        rows = self.run_worker('{"version":1,"id":"1","command":"probe"}\n{"version":1,"id":"2","command":"shutdown"}\n')
        self.assertEqual(rows[0], {'version': 1, 'id': '1', 'ok': True, 'kind': 'diagnostic'})
        self.assertEqual(rows[1]['id'], '2')

    def test_rejects_invalid_and_unknown_messages_without_echo(self):
        for message in ['bad-private-text', '{"version":2,"id":"1","command":"probe"}', '{"version":1,"id":"1","command":"exec"}', '{"version":1,"id":"1","command":"probe","path":"secret"}', '[]', 'x' * 5000]:
            rows = self.run_worker(message + '\n')
            self.assertEqual(len(rows), 1)
            self.assertFalse(rows[0]['ok'])
            self.assertNotIn('secret', json.dumps(rows))
            self.assertNotIn('private-text', json.dumps(rows))

    def test_eof_exits_without_output(self):
        self.assertEqual(self.run_worker(''), [])

    def test_partial_line_at_eof_is_rejected(self):
        self.assertFalse(self.run_worker('{"version":1,"id":"1","command":"probe"}')[0]['ok'])


if __name__ == '__main__':
    unittest.main()
