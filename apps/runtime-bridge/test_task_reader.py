import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from task_reader import LocalTaskReader


def record(kind, turn='synthetic-turn'):
    if kind == 'session_meta':
        value = {'type': kind, 'payload': {'source': turn}}
    else:
        value = {'type': 'event_msg', 'payload': {'type': kind, 'turn_id': turn, 'text': 'fixture text'}}
    return json.dumps(value).encode() + b'\n'


@unittest.skipUnless(os.name == 'posix', 'POSIX directory descriptor reader')
class LocalTaskReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.day = self.home / '.codex/sessions/2026/11/18'
        self.day.mkdir(parents=True)
        self.rollout = self.day / 'rollout-synthetic.jsonl'
        self.rollout.write_bytes(record('session_meta', 'vscode') + record('task_complete', 'older'))
        self.reader = LocalTaskReader(str(self.home))

    def append(self, data):
        with self.rollout.open('ab') as stream:
            stream.write(data)

    def test_cold_replay_is_not_a_new_start_and_distinct_rounds_complete_independently(self):
        self.append(record('task_started', 'historical'))
        cold = self.reader.poll()
        self.assertEqual((cold.state, cold.active_count, cold.start_serial), ('working', 1, 0))
        self.append(record('turn_started', 'live') + record('task_complete', 'historical'))
        active = self.reader.poll()
        self.assertEqual((active.state, active.active_count, active.start_serial), ('working', 1, 1))
        self.append(record('turn_aborted', 'live'))
        self.assertEqual(self.reader.poll().state, 'idle')

    def test_cached_day_replaced_by_link_is_never_read(self):
        self.assertEqual(self.reader.poll().state, 'idle')
        elsewhere = self.home / 'outside'
        self.day.rename(elsewhere)
        self.day.symlink_to(elsewhere, target_is_directory=True)
        self.append(record('task_started'))
        self.assertEqual(self.reader.poll().state, 'unknown')

    def test_linked_root_or_rollout_and_special_file_are_not_read(self):
        outside = self.home / 'outside'
        outside.write_bytes(record('session_meta', 'vscode') + record('task_started'))
        self.rollout.unlink()
        self.rollout.symlink_to(outside)
        os.mkfifo(self.day / 'rollout-fifo.jsonl')
        self.assertEqual(self.reader.poll().state, 'unknown')
        codex = self.home / '.codex'
        shifted = self.home / 'other'
        codex.rename(shifted)
        codex.symlink_to(shifted, target_is_directory=True)
        self.assertEqual(self.reader.poll().state, 'unknown')

    def test_file_replacement_restarts_cursor_without_replaying_start_signal(self):
        self.assertEqual(self.reader.poll().state, 'idle')
        self.append(record('turn_started'))
        self.assertEqual(self.reader.poll().start_serial, 1)
        other = self.day / 'replacement'
        other.write_bytes(record('session_meta', 'exec') + record('turn_started', 'replacement'))
        other.replace(self.rollout)
        recovered = self.reader.poll()
        self.assertEqual((recovered.state, recovered.active_count, recovered.start_serial), ('working', 1, 0))
        self.append(record('turn_started', 'next'))
        self.assertEqual(self.reader.poll().start_serial, 2)

    def test_reads_include_headers_in_file_and_poll_budgets(self):
        for index in range(5):
            (self.day / f'rollout-{index}.jsonl').write_bytes(self.rollout.read_bytes() + b' ' * 4096)
        reads = {}
        pread = os.pread

        def measure(fd, count, offset):
            data = pread(fd, count, offset)
            inode = os.fstat(fd).st_ino
            reads[inode] = reads.get(inode, 0) + len(data)
            return data

        with patch('task_reader.POLL_BYTES', 576), patch('task_reader.TAIL_BYTES', 384), \
                patch('task_reader.MAX_HEADER', 128), patch('task_reader.os.pread', side_effect=measure):
            self.assertEqual(self.reader.poll().state, 'unknown')
        self.assertEqual(sum(reads.values()), 576)
        self.assertLessEqual(max(reads.values()), 384)

    def test_archived_and_hard_linked_rollouts_are_excluded(self):
        archive = self.home / '.codex/archived_sessions/2026/11/18'
        archive.mkdir(parents=True)
        private = archive / 'rollout-private.jsonl'
        private.write_bytes(record('session_meta', 'vscode') + record('turn_started'))
        os.link(private, self.day / 'rollout-hardlink.jsonl')
        self.assertEqual(self.reader.poll().state, 'idle')

    def test_malformed_event_does_not_block_other_valid_rollouts(self):
        self.append(b'{"type":"event_msg","payload":{"type":[]}}\n')
        safe = self.day / 'rollout-valid.jsonl'
        safe.write_bytes(record('session_meta', 'vscode') + record('turn_started'))
        result = self.reader.poll()
        self.assertEqual((result.state, result.active_count), ('working', 1))

    def test_unread_backlog_does_not_publish_previously_active_turn(self):
        self.append(record('turn_started'))
        self.assertEqual(self.reader.poll().state, 'working')
        self.append(b'{"type":"response_item","payload":"' + b' ' * 512 + b'"}\n' + record('turn_complete'))
        with patch('task_reader.POLL_BYTES', 384), patch('task_reader.TAIL_BYTES', 384):
            self.assertEqual(self.reader.poll().state, 'unknown')
            self.assertEqual(self.reader.poll().state, 'idle')
