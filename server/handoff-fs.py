"""Open task-owned files using directory descriptors on macOS and Linux."""
import base64
import hashlib
import json
import os
from pathlib import PurePosixPath
import stat
import sys
import uuid
from contextlib import ExitStack

LIMIT = 1024 * 1024
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def open_dir(stack, name, parent=None, create=False):
    if create:
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
    fd = os.open(name, DIR, dir_fd=parent)
    stack.callback(os.close, fd)
    return fd


def safe_bytes(folder, name):
    fd = os.open(name, FILE, dir_fd=folder)
    with os.fdopen(fd, 'rb') as src:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                before.st_uid != os.getuid() or before.st_size > LIMIT):
            raise ValueError('Expected a single private regular file within 1 MiB')
        data = src.read(LIMIT + 1)
        after = os.fstat(fd)
        if (len(data) != before.st_size or after.st_size != before.st_size or
                before.st_mtime_ns != after.st_mtime_ns or after.st_nlink != 1):
            raise ValueError('File changed during capture')
        return data


def encode(data):
    return dict(size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                data=base64.b64encode(data).decode('ascii'))


def receive(folder):
    packet = json.load(sys.stdin)
    content = base64.b64decode(packet['data'], validate=True)
    if len(content) > LIMIT or len(content) != packet['size'] or hashlib.sha256(content).hexdigest() != packet['sha256']:
        raise ValueError('Incoming file failed size or SHA-256 check')
    temp = '.input-' + uuid.uuid4().hex
    fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=folder)
    try:
        with os.fdopen(fd, 'wb') as dst:
            dst.write(content)
            dst.flush()
            os.fsync(dst.fileno())
        try:
            # Atomically publish without replacing an existing name; retries compare it.
            os.link(temp, 'input', src_dir_fd=folder, dst_dir_fd=folder, follow_symlinks=False)
        except FileExistsError:
            pass
    finally:
        os.unlink(temp, dir_fd=folder)
    os.fsync(folder)
    if safe_bytes(folder, 'input') != content:
        raise ValueError('Staged file does not match its receipt')


def run():
    action, workspace, task = sys.argv[1:]
    if action not in ('prepare', 'read', 'stage') or str(uuid.UUID(task)) != task:
        raise ValueError('Invalid task handoff')
    parts = PurePosixPath(workspace).parts
    if not parts or parts[0] != '/' or '..' in parts:
        raise ValueError('Invalid workspace')
    with ExitStack() as stack:
        folder = open_dir(stack, '/')
        for part in parts[1:]:
            folder = open_dir(stack, part, folder)
        taskdir = open_dir(stack, task, folder, create=action == 'prepare')
        area = open_dir(stack, 'handoff', taskdir, create=action == 'prepare')
        if action == 'read':
            print(json.dumps(encode(safe_bytes(area, 'output'))))
        elif action == 'stage':
            receive(area)


if __name__ == '__main__':
    try:
        run()
    except (OSError, ValueError, KeyError, TypeError):
        print('Task handoff could not verify the requested file or directory.', file=sys.stderr)
        sys.exit(1)
