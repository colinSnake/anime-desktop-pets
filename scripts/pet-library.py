#!/usr/bin/env python3
"""离线素材库 CLI；导入不启动桌宠，也不修改当前 helper/历史/账号。"""
import argparse
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/pets'))
from pet_library import PackageError, audit_bailong, delete_package, import_package, list_packages, write_report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', type=Path, help='独立素材库目录；导入/列表必须显式指定，不猜用户数据位置')
    commands = parser.add_subparsers(dest='command', required=True)
    audit = commands.add_parser('audit-bailong', help='只读核验当前 35 动作；不复制素材')
    audit.add_argument('--source', type=Path, default=ROOT / '.local/pet-build/source')
    audit.add_argument('--report', type=Path, required=True)
    install = commands.add_parser('import', help='校验并原子安装 .petpack；不激活')
    install.add_argument('archive', type=Path)
    commands.add_parser('list', help='只读列出已安装包；不重新解码')
    delete = commands.add_parser('delete', help='删除未被任何实例引用的素材包版本')
    delete.add_argument('id')
    delete.add_argument('version')
    delete.add_argument('--instances', type=Path, required=True, help='对应 profile 的 pet-instances.json')
    args = parser.parse_args()
    try:
        if args.command == 'audit-bailong':
            report = audit_bailong(args.source)
            write_report(args.report, report)
            result = dict(ok=True, report=str(args.report.resolve()), **report['summary'])
        else:
            if args.library is None:
                parser.error('import/list 必须显式传 --library，不写入既有桌宠目录')
            if args.command == 'import':
                result = dict(ok=True, package=import_package(args.archive, args.library))
            elif args.command == 'delete':
                result = dict(ok=True, package=delete_package(args.library, args.id, args.version, args.instances))
            else:
                result = dict(ok=True, packages=list_packages(args.library))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (PackageError, OSError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError) as error:
        print(json.dumps(dict(ok=False, error=str(error)), ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
