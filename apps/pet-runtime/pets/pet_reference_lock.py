"""Cross-process lock shared by package deletion and instance registry writes."""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import stat


class ReferenceLockError(RuntimeError):
    pass


@contextmanager
def reference_lock(registry_path):
    registry_path = Path(registry_path).expanduser()
    parent = registry_path.parent
    if parent.is_symlink() or not parent.is_dir():
        raise ReferenceLockError('实例数据目录不存在或为符号链接')
    path = parent / '.pet-instances.references.lock'
    try:
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    except OSError as error:
        raise ReferenceLockError('无法安全打开实例引用锁') from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ReferenceLockError('实例引用锁文件无效')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ReferenceLockError('实例清单正在更新，请稍后重试') from error
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise ReferenceLockError('实例引用锁被替换；拒绝继续')
        yield
    finally:
        os.close(fd)
