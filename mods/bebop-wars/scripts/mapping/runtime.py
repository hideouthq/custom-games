from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / '.tools/modlock-tools'
ADDON = 'bebop_wars'
SOURCE = ROOT / 'content/citadel_addons' / ADDON
WORK = ROOT / '.local/mapping'
OUTPUT = ROOT / '.local/compiled' / ADDON

def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

@contextmanager
def workspace_lock():
    WORK.mkdir(parents=True, exist_ok=True)
    with (WORK / 'workspace.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another map edit or build is running; retry after it finishes')
        try: yield
        finally: fcntl.flock(lock, fcntl.LOCK_UN)

def desktop_env():
    env = os.environ.copy()
    # A process started by another tool may get a minimal environment, even on the desktop.
    session = Path('/run/user') / str(os.getuid())
    if (session / 'bus').exists():
        env.setdefault('XDG_RUNTIME_DIR', str(session))
        env.setdefault('DBUS_SESSION_BUS_ADDRESS', 'unix:path=' + str(session / 'bus'))
    result = subprocess.run(['systemctl', '--user', 'show-environment'], env=env, capture_output=True, text=True, timeout=5)
    for line in result.stdout.splitlines():
        key, _, value = line.partition('=')
        if key in {'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'}:
            env[key] = value
    return env

def hammer_windows():
    env = desktop_env()
    result = subprocess.run(['xdotool', 'search', '--name', '^Hammer'], env=env,
                            capture_output=True, text=True, timeout=5)
    if result.returncode not in (0, 1) or 'Failed creating' in result.stderr or 'Authorization required' in result.stderr:
        raise RuntimeError('Cannot inspect Hammer windows; run from the desktop session')
    windows = []
    for wid in result.stdout.split():
        title = subprocess.check_output(['xdotool', 'getwindowname', wid], env=env, text=True, timeout=5).strip()
        windows.append({'id': wid, 'title': title})
    return windows

def ensure_closed(map_name):
    for window in hammer_windows():
        if map_name + '.vmap' in window['title']:
            raise RuntimeError('Close this map in Hammer before editing it here; this prevents stale editor saves')

def win(path):
    return 'Z:' + str(path.absolute()).replace('/', '\\')

def prepare():
    for directory, source in [('content', SOURCE), ('game', OUTPUT)]:
        target = SDK / directory / 'citadel_addons' / ADDON
        source.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            if target.resolve() != source.resolve(): raise RuntimeError('Existing addon points elsewhere: '+str(target))
        else:
            target.parent.mkdir(parents=True, exist_ok=True); target.symlink_to(source, target_is_directory=True)
    profile = SDK / 'game/bebop_mapping_tools'
    base = (SDK / 'game/citadel/gameinfo.gi').read_text()
    # VRAD discovers gameinfo from its scratch directory under the Write root.
    for old, new in {
        '            Mod citadel\n': f'            Mod {profile.name}\n',
        '            Write citadel\n': f'            Write {profile.name}\n',
        '            Game citadel\n': f'            Game citadel_addons/{ADDON}\n            Game citadel\n',
    }.items():
        if base.count(old) != 1: raise RuntimeError('SDK gameinfo layout changed')
        base = base.replace(old, new, 1)
    atomic(profile / 'gameinfo.gi', base.encode())
    return profile

def environment():
    env = desktop_env()
    steam = Path.home() / '.local/share/Steam'
    env.update(STEAM_COMPAT_DATA_PATH=str(ROOT / '.local/proton'),
               STEAM_COMPAT_CLIENT_INSTALL_PATH=str(steam), SteamAppId='0', SteamGameId='0')
    proton = steam / 'steamapps/common/Proton - Experimental/proton'
    return env, proton

def compiler_run(command, env, log):
    with log.open('w') as stream:
        child = subprocess.Popen([str(x) for x in command], cwd=SDK/'game/bin/win64', env=env,
                                 stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        try: code = child.wait(timeout=900)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait()
            raise RuntimeError('Compiler exceeded fifteen minutes; only its process group was stopped')
    report = log.read_text(errors='replace')
    if code or re.search(r'\b[1-9][0-9]* failed\b', report) or 'referencing missing material' in report:
        raise RuntimeError('Compiler failed; inspect '+str(log))
    return [line.strip() for line in report.splitlines() if any(k in line.lower() for k in ('warning','failed loading','missing'))][:40]
