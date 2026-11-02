#!/usr/bin/env python3
"""多宠开发控制客户端；仅连接显式profile中已有的控制器，不启动或安装任何应用。"""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/pets'))
from dragon_instance_ipc import send_command


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--timeout', type=float, default=2.0)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('status', 'stop-all', 'shutdown'): commands.add_parser(name)
    for name in ('start', 'stop'):
        command = commands.add_parser(name); command.add_argument('instance_id')
    command = commands.add_parser('clone'); command.add_argument('source_id'); command.add_argument('clone_id')
    command = commands.add_parser('start-selected'); command.add_argument('instance_ids', nargs='+')
    command = commands.add_parser('set-size'); command.add_argument('instance_id'); command.add_argument('size', type=int)
    args = parser.parse_args()
    fields = {}
    command = {'start': 'start_pet', 'stop': 'stop_pet', 'start-selected': 'start_selected',
               'stop-all': 'stop_all', 'set-size': 'set_preferences', 'clone': 'clone_pet'}.get(args.command, args.command)
    if hasattr(args, 'instance_id'): fields['instanceID'] = args.instance_id
    if hasattr(args, 'instance_ids'): fields['instanceIDs'] = args.instance_ids
    if args.command == 'clone': fields['instanceID'] = args.source_id; fields['cloneID'] = args.clone_id
    if args.command == 'set-size': fields['preferences'] = dict(size=args.size)
    try:
        response = send_command(args.profile, command, timeout=args.timeout, **fields)
        print(json.dumps(response, ensure_ascii=False, indent=2))
        return 0 if response['ok'] else 1
    except (OSError, ValueError, TypeError) as error:
        print(json.dumps(dict(ok=False, error=str(error)), ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
