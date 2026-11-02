#!/usr/bin/env python3
"""打开独立的本地宠物素材库管理窗口；不启动或修改桌宠实例。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/pets'))
from pet_library_ui import main


if __name__ == '__main__':
    raise SystemExit(main())
