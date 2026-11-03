#!/usr/bin/env python3
"""任务跟随隔离回归：仅合成rollout和lease，不读取真实Codex数据。"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
from dragon_tasks import (Cursor, RolloutReader, LeasedReader, TaskSnapshot, lease_enabled,
                          MAX_LINE, TAIL_BYTES, STALE_SECONDS)


def event(kind, turn='a', **extra):
    return (json.dumps(dict(type='event_msg', payload=dict(type=kind, turn_id=turn, **extra))) + '\n').encode()


def meta(source='vscode'):
    return (json.dumps(dict(type='session_meta', payload=dict(source=source, cli_version='fixture'))) + '\n').encode()


class TaskReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='dragon-task-fixture-')
        self.home = Path(self.tmp.name)
        self.now = 1793664000.
        self.reader = RolloutReader(self.home, lambda: self.now)
        self.directory = self.home / 'sessions/2026/11/03'
        self.directory.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def rollout(self, name='first', data=None, directory=None):
        target = (directory or self.directory) / ('rollout-' + name + '.jsonl')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(meta() + (event('task_started') if data is None else data))
        os.utime(target, (self.now, self.now))
        return target

    def append(self, path, data):
        with path.open('ab') as stream:
            stream.write(data)
        os.utime(path, (self.now, self.now))

    def test_start_finish_and_duplicate_events(self):
        p = self.rollout()
        self.assertEqual(self.reader.poll(), TaskSnapshot('working', 1))
        self.append(p, event('task_started'))
        self.assertEqual(self.reader.poll().active_count, 1)
        self.append(p, event('task_complete', last_agent_message='private response'))
        self.assertEqual(self.reader.poll().state, 'idle')
        self.assertFalse(self.reader.poll().active)

    def test_official_v2_aliases_are_lifecycle_events(self):
        p = self.rollout(data=event('turn_started'))
        self.assertTrue(self.reader.poll().active)
        self.append(p, event('turn_complete'))
        self.assertEqual(self.reader.poll().state, 'idle')

    def test_same_inode_truncation_and_new_file_discovery(self):
        p = self.rollout(data=event('task_started') + b' ' * 2000 + b'\n')
        self.reader.poll()
        p.write_bytes(meta() + event('task_complete')); os.utime(p, (self.now, self.now))
        self.assertEqual(self.reader.poll().state, 'idle')
        self.rollout('new', data=event('task_started', 'new'))
        self.now += 6
        self.assertTrue(self.reader.poll().active)

    def test_file_count_and_read_budget_bound_work(self):
        for index in range(70):
            self.rollout(str(index))
        snapshot = self.reader.poll()
        self.assertEqual(snapshot.active_count, 64)
        self.assertEqual(len(self.reader.cursors), 64)

    def test_round_robin_budget_reaches_recent_sessions_beyond_first_eight_files(self):
        padding = json.dumps(dict(type='response_item', payload=dict(type='message', text='x' * (600 * 1024)))) + '\n'
        for index in range(12):
            self.rollout(str(index), data=padding.encode() + event('task_started', str(index)))
        for _ in range(7):
            snapshot = self.reader.poll()
        self.assertEqual(snapshot.state, 'working')
        self.assertEqual(snapshot.active_count, 12)

    def test_active_turn_in_unprocessed_cursor_stays_in_snapshot(self):
        paths = [self.rollout(str(i), data=event('task_started', str(i))) for i in range(12)]
        for _ in range(10): self.reader.poll()
        self.assertEqual(self.reader.poll().active_count, 12)
        self.reader.next_path = paths[0]
        with patch('dragon_tasks.POLL_BYTES', 1):
            self.assertEqual(self.reader.poll().active_count, 12)

    def test_turn_identity_prevents_old_completion_stopping_new_task(self):
        p = self.rollout(data=event('task_started', 'a') + event('task_started', 'b'))
        self.assertEqual(self.reader.poll().active_count, 2)
        self.append(p, event('task_complete', 'a') * 2)
        self.assertEqual(self.reader.poll().active_count, 1)
        self.append(p, event('turn_aborted', 'b'))
        self.assertEqual(self.reader.poll().state, 'idle')

    def test_many_sessions_aggregate_and_do_not_read_archived(self):
        a = self.rollout('a'); self.rollout('b')
        self.rollout('archived', directory=self.home / 'archived_sessions')
        self.assertEqual(self.reader.poll().active_count, 2)
        self.append(a, event('task_complete'))
        self.assertEqual(self.reader.poll().active_count, 1)

    def test_old_date_directory_with_resumed_work_is_discovered(self):
        self.rollout(directory=self.home / 'sessions/2025/01/01')
        self.assertTrue(self.reader.poll().active)

    def test_non_message_fields_only_retain_turns(self):
        p = self.rollout(data=event('task_started') + (json.dumps(dict(type='response_item', payload=dict(type='message', text='secret-value'))) + '\n').encode())
        self.assertTrue(self.reader.poll().active)
        c = self.reader.cursors[p]
        self.assertNotIn('secret-value', repr(c))
        self.assertEqual(c.pending, b'')
        self.assertEqual(c.turns, {'a'})

    def test_partial_line_is_not_consumed_until_newline(self):
        line = event('task_complete')
        p = self.rollout()
        self.reader.poll(); self.append(p, line[:-3])
        self.assertTrue(self.reader.poll().active)  # retain committed state until newline
        self.append(p, line[-3:])
        self.assertEqual(self.reader.poll().state, 'idle')

    def test_malformed_oversized_and_unknown_records_fail_closed(self):
        p = self.rollout(data=b'not-json\n' + b'x' * (MAX_LINE + 100) + b'\n')
        self.assertEqual(self.reader.poll().state, 'unknown')
        self.assertLessEqual(len(self.reader.cursors[p].pending), MAX_LINE)
        self.append(p, event('task_started', 'fresh'))
        self.assertTrue(self.reader.poll().active)

    def test_large_compaction_and_tail_fragment_do_not_poison_known_lifecycle(self):
        p = self.rollout(data=event('task_started'))
        self.assertTrue(self.reader.poll().active)

    def test_tail_start_inside_partial_old_line_is_discarded_not_uncertain(self):
        padding = (json.dumps(dict(type='response_item', payload=dict(type='function_call_output', output='x' * (TAIL_BYTES + MAX_LINE)))) + '\n').encode()
        p = self.rollout(data=event('task_started') + padding + event('task_started', 'b'))
        os.utime(p, (self.now - STALE_SECONDS - 5, self.now - STALE_SECONDS - 5))
        self.assertEqual(self.reader.poll().state, 'unknown')
        cursor = self.reader.cursors[p]
        self.assertFalse(cursor.uncertain)
        p.write_bytes(meta() + event('task_started', 'b'))
        os.utime(p, (self.now, self.now))
        self.assertTrue(self.reader.poll().active)
        self.append(p, b'{"type":"compacted","payload":{"message":"' + b'x' * (MAX_LINE + 8) + b'"}}\n')
        self.assertTrue(self.reader.poll().active)

    def test_long_tool_output_does_not_erase_running_turn(self):
        p = self.rollout(); self.assertTrue(self.reader.poll().active)
        self.append(p, (json.dumps(dict(type='response_item', payload=dict(type='function_call_output', output='x' * (MAX_LINE * 3)))) + '\n').encode())
        for _ in range(4):
            self.assertTrue(self.reader.poll().active)
        self.assertTrue(self.reader.poll().active)
        self.append(p, event('task_complete'))
        self.assertEqual(self.reader.poll().state, 'idle')

    def test_oversized_completion_projects_structural_turn_fields(self):
        p = self.rollout(); self.reader.poll()
        self.append(p, event('task_complete', last_agent_message='x' * (MAX_LINE * 3)))
        for _ in range(4): self.reader.poll()
        self.assertEqual(self.reader.poll().state, 'idle')

    def test_cold_start_recovers_begin_outside_previous_tail_limit(self):
        p = self.rollout(data=event('task_started') + (json.dumps(dict(type='response_item', payload=dict(output='x' * (MAX_LINE * 4)))) + '\n').encode())
        for _ in range(5): result = self.reader.poll()
        self.assertTrue(result.active)
        self.assertFalse(self.reader.cursors[p].uncertain)

    def test_content_that_mentions_lifecycle_cannot_create_a_turn(self):
        text = json.dumps(dict(type='response_item', payload=dict(output='task_started turn_id fake' * MAX_LINE))) + '\n'
        p = self.rollout(data=text.encode())
        for _ in range(15): self.reader.poll()
        self.assertFalse(self.reader.poll().active)
        self.assertFalse(self.reader.cursors[p].turns)

    def test_stale_tasks_become_unknown_not_completed(self):
        p = self.rollout(); self.reader.poll()
        self.now += STALE_SECONDS + 1
        self.assertEqual(self.reader.poll().state, 'unknown')
        self.append(p, event('task_complete'))
        self.assertEqual(self.reader.poll().state, 'idle')

    def test_replaced_truncated_and_deleted_files_do_not_keep_active_turns(self):
        p = self.rollout(); self.reader.poll()
        p.write_bytes(meta() + event('task_complete')); os.utime(p, (self.now, self.now))
        # Explicit inode replacement covers rename-based file replacement.
        other = p.with_suffix('.new'); other.write_bytes(meta() + event('task_complete'))
        os.utime(other, (self.now, self.now)); other.replace(p)
        self.assertEqual(self.reader.poll().state, 'idle')
        p.unlink()
        self.assertFalse(self.reader.poll().active)

    def test_subagent_unknown_producers_and_symlinks_are_excluded(self):
        self.rollout('agent', meta({'subagent': 'fixture'}) + event('task_started'))
        # rollout() prepends a default header; later session_meta still overrides it.
        self.rollout('unknown', meta('unrecognized') + event('task_started'))
        outside = self.home / 'outside'; outside.write_bytes(meta() + event('task_started'))
        (self.directory / 'rollout-link.jsonl').symlink_to(outside)
        self.assertFalse(self.reader.poll().active)

    def test_budget_and_tail_cannot_replay_old_busy_state(self):
        p = self.rollout(data=event('task_started') + b'x' * (600 * 1024) + b'\n' + event('task_complete'))
        self.assertFalse(self.reader.poll().active)
        self.assertLessEqual(len(self.reader.cursors[p].pending), MAX_LINE)

    def test_missing_root_is_disconnected(self):
        self.assertEqual(RolloutReader(self.home / 'absent').poll().state, 'disconnected')

    def test_missing_turn_id_does_not_mark_task_finished(self):
        p = self.rollout(); self.reader.poll()
        self.append(p, b'{"type":"event_msg","payload":{"type":"task_complete"}}\n')
        self.assertEqual(self.reader.poll().state, 'unknown')

    def test_lease_expires_and_disables_without_accessing_rollouts(self):
        lease = self.home / 'lease.json'
        reader = LeasedReader(self.home, lease, lambda: self.now)
        with patch.object(reader.reader, 'poll', side_effect=AssertionError('must not scan')):
            self.assertEqual(reader.poll().state, 'disabled')
        lease.write_text(json.dumps(dict(schemaVersion=1, enabled=True, observedAt=self.now)))
        self.assertTrue(lease_enabled(lease, self.now))
        self.rollout()
        self.assertTrue(reader.poll().active)
        self.now += 11
        self.assertEqual(reader.poll().state, 'disabled')
        self.assertFalse(reader.reader.cursors)
        self.assertFalse(lease_enabled(lease, self.now))

    def test_future_invalid_and_linked_leases_are_rejected(self):
        lease = self.home / 'lease.json'
        for value in ([], {}, dict(schemaVersion=1, enabled=True, observedAt=self.now + 2),
                      dict(schemaVersion=1, enabled=1, observedAt=self.now),
                      dict(schemaVersion=1, enabled=True, observedAt='invalid')):
            lease.write_text(json.dumps(value)); self.assertFalse(lease_enabled(lease, self.now))
        lease.unlink(); lease.symlink_to(self.home / 'other')
        self.assertFalse(lease_enabled(lease, self.now))


if __name__ == '__main__':
    unittest.main(verbosity=2)
