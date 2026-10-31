// The same stdlib-only helper runs at both ends of the SSH pipe. No payload
// bytes appear in argv; only the already-confined mapping and fixed program do.
export const FILE_SYNC_SCRIPT = String.raw`
import fnmatch
import json
import os
import secrets
import shutil
import signal
import stat
import sys
import tarfile

CHUNK = 16 * 1024
MAX_METADATA = 256 * 1024
MAX_DIRECTORIES = 100000
mapping = json.loads(sys.argv[2])


def absolute(value):
    if not isinstance(value, str) or not value.startswith('/') or '\x00' in value:
        raise ValueError('sync paths must be absolute')
    parts = value.split('/')[1:]
    if not parts or any(p in ('', '.', '..') for p in parts):
        raise ValueError('sync paths must be canonical and below the filesystem root')
    return parts


def directory_fd(parts, create=False, base=None):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY) if base is None else os.dup(base)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def member_parts(name):
    if name.startswith('/') or '\x00' in name:
        raise ValueError('absolute or invalid tar member')
    # tar's conventional leading ./ is harmless, but never normalize away ..
    parts = name.split('/')
    if any(p == '..' for p in parts):
        raise ValueError('tar member traverses its target')
    return [p for p in parts if p not in ('', '.')]


def excluded(name):
    # Match Execute's TAR_SKIP_RUNTIME_DIR for directory contents. An explicit
    # runtime asset root still works because its relative root name is '.'.
    if '.paperclip-runtime' in name.split('/'):
        return True
    for pattern in mapping.get('exclude') or []:
        pattern = pattern.removeprefix('./').rstrip('/')
        if fnmatch.fnmatchcase(name, pattern) or fnmatch.fnmatchcase(name, pattern.removeprefix('**/')):
            return True
        if '/' not in pattern and any(fnmatch.fnmatchcase(p, pattern) for p in name.split('/')):
            return True
    return False


def preflight():
    def visit(file, name, ancestors):
        if name != '.' and excluded(name):
            return
        target = mapping['targetPath'] if name == '.' else mapping['targetPath'] + '/' + name
        print(json.dumps(target), flush=True)
        info = os.stat(file, follow_symlinks=bool(mapping.get('followSymlinks')))
        if not stat.S_ISDIR(info.st_mode):
            return
        key = (info.st_dev, info.st_ino)
        if key in ancestors or len(ancestors) >= 256:
            raise ValueError('directory symlink cycle or excessive depth')
        with os.scandir(file) as children:
            for child in children:
                visit(child.path, child.name if name == '.' else name + '/' + child.name, ancestors | {key})
    visit(mapping['sourcePath'], '.', set())


def send():
    source = mapping['sourcePath']
    follow = mapping['kind'] == 'file' or bool(mapping.get('followSymlinks'))
    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|', dereference=follow, format=tarfile.GNU_FORMAT) as archive:
        def visit(file, name, ancestors):
            if name != '.' and excluded(name):
                return
            # Do not emit hardlinks: every regular file carries its own bytes.
            archive.inodes.clear()
            info = archive.gettarinfo(file, arcname=name)
            if info is None or not (info.isfile() or info.isdir() or info.issym()):
                raise ValueError('unsupported sync source type')
            if mapping['kind'] == 'file' and not info.isfile():
                raise ValueError('file mapping requires a regular source')
            if mapping['kind'] == 'directory' and name == '.' and not info.isdir():
                raise ValueError('directory mapping requires a directory source')
            if info.isfile():
                with open(file, 'rb') as contents:
                    archive.addfile(info, contents)
            else:
                archive.addfile(info)
            if info.isdir():
                identity = os.stat(file)
                key = (identity.st_dev, identity.st_ino)
                if key in ancestors or len(ancestors) >= 256:
                    raise ValueError('directory symlink cycle or excessive depth')
                with os.scandir(file) as children:
                    for child in children:
                        visit(child.path, child.name if name == '.' else name + '/' + child.name, ancestors | {key})
        visit(source, 'payload' if mapping['kind'] == 'file' else '.', set())


class BoundedTarInfo(tarfile.TarInfo):
    # Our producer uses GNU long names, not PAX/sparse records. Reject all other
    # extensions before tarfile can buffer or expand untrusted metadata.
    # Regular-file contents are read in CHUNK-sized pieces below.
    def _proc_member(self, archive):
        extensions = (tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK)
        if self.type in extensions:
            if self.size > MAX_METADATA:
                raise ValueError('tar extension exceeds metadata limit')
        elif not (self.isfile() or self.isdir() or self.issym()):
            raise ValueError('unsupported tar member (including hardlinks)')
        return super()._proc_member(archive)


def receive():
    target = absolute(mapping['targetPath'])
    parent = directory_fd(target[:-1], create=True)
    root = None
    scratch = None
    directories = []
    files = 0
    byte_count = 0
    single = mapping['kind'] == 'file'
    try:
        if not single:
            try:
                current = os.stat(target[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                current = None
            if current is not None:
                if not stat.S_ISDIR(current.st_mode):
                    raise ValueError('directory target is not a real directory')
                if not shutil.rmtree.avoids_symlink_attacks:
                    raise ValueError('safe directory replacement is unavailable')
                shutil.rmtree(target[-1], dir_fd=parent)
            os.mkdir(target[-1], 0o700, dir_fd=parent)
            root = directory_fd([target[-1]], base=parent)
        with tarfile.open(fileobj=sys.stdin.buffer, mode='r|', tarinfo=BoundedTarInfo) as archive:
            for member in archive:
                # Hardlink lookups and sparse expansion are intentionally unsupported.
                archive.members.clear()
                if member.sparse is not None:
                    raise ValueError('sparse tar entries are unsupported')
                parts = member_parts(member.name)
                if single:
                    if parts != ['payload'] or not member.isfile() or files:
                        raise ValueError('invalid single-file archive')
                    fd_parent = os.dup(parent)
                    scratch = '.paperclip-upload.' + secrets.token_hex(16)
                    name = scratch
                else:
                    if not parts:
                        if not member.isdir():
                            raise ValueError('invalid tar root')
                        directories.append(([], member.mode & 0o777))
                        continue
                    fd_parent = directory_fd(parts[:-1], create=True, base=root)
                    name = parts[-1]
                try:
                    if member.isdir():
                        try:
                            os.mkdir(name, 0o700, dir_fd=fd_parent)
                        except FileExistsError:
                            check = directory_fd([name], base=fd_parent)
                            os.close(check)
                        if len(directories) >= MAX_DIRECTORIES:
                            raise ValueError('too many tar directories')
                        directories.append((parts, member.mode & 0o777))
                    elif member.issym():
                        # Preserve links, including external leaf links, but never open
                        # one as a parent. Every subsequent parent walk uses NOFOLLOW.
                        os.symlink(member.linkname, name, dir_fd=fd_parent)
                    elif member.isfile():
                        mode = mapping.get('mode')
                        if mode is None:
                            mode = member.mode & 0o777
                        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd_parent)
                        try:
                            os.fchmod(fd, mode)
                            # Default io buffers are interpreter-defined (8 KiB
                            # through 3.13, 128 KiB from 3.14). Pin both ends to
                            # CHUNK so bytes land as they arrive: an unbuffered
                            # write, and read1(), one bounded read of the member,
                            # instead of read() filling the default buffer first.
                            with os.fdopen(fd, 'wb', buffering=0) as dest:
                                fd = None
                                contents = archive.extractfile(member)
                                remaining = member.size
                                while remaining:
                                    chunk = contents.read1(min(CHUNK, remaining))
                                    if not chunk:
                                        raise ValueError('truncated tar payload')
                                    view = memoryview(chunk)
                                    while view:
                                        view = view[dest.write(view):]
                                    remaining -= len(chunk)
                        finally:
                            if fd is not None:
                                os.close(fd)
                        files += 1
                        byte_count += member.size
                    else:
                        raise ValueError('unsupported tar member')
                finally:
                    os.close(fd_parent)
        # tarfile stops at its end marker, before the transport necessarily
        # reaches EOF. Drain record padding before committing/closing stdin so
        # the sender's last bounded write cannot race a closed receiver pipe.
        while sys.stdin.buffer.read(CHUNK):
            pass
        if single:
            if files != 1:
                raise ValueError('single-file archive is empty')
            os.replace(scratch, target[-1], src_dir_fd=parent, dst_dir_fd=parent)
            scratch = None
        else:
            # Keep directories private/traversable while their children land;
            # restore source directory modes bottom-up only after the stream ends.
            for parts, mode in reversed(directories):
                fd = directory_fd(parts, base=root)
                try:
                    os.fchmod(fd, mode)
                finally:
                    os.close(fd)
        print(json.dumps({'filesTransferred': files, 'bytesTransferred': byte_count}))
    finally:
        if scratch is not None:
            try:
                os.unlink(scratch, dir_fd=parent)
            except FileNotFoundError:
                pass
        if root is not None:
            os.close(root)
        os.close(parent)


def interrupted(signum, frame):
    # Python's default TERM/HUP exits skip finally, leaking partial scratch.
    # Unwind once, allowing the receiver to close and unlink through its dir-fd.
    for caught in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(caught, signal.SIG_IGN)
    raise InterruptedError('native sync interrupted')


for caught in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(caught, interrupted)

absolute(mapping['sourcePath'])
absolute(mapping['targetPath'])
if mapping['kind'] not in ('file', 'directory'):
    raise ValueError('invalid sync mapping kind')
mode = mapping.get('mode')
if mode is not None and (not isinstance(mode, int) or isinstance(mode, bool) or mode < 0 or mode > 0o777):
    raise ValueError('invalid sync file mode')
if sys.argv[1] == 'send':
    send()
elif sys.argv[1] == 'receive':
    receive()
elif sys.argv[1] == 'preflight':
    preflight()
else:
    raise ValueError('invalid sync action')
`;
