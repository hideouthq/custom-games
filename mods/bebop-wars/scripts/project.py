#!/usr/bin/env python3
"""Fresh Bebop Wars asset workspace: install, link, and run Modlock Tools on Linux."""
import argparse
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT / 'tools/modlock-sdk'
TOOLS = ROOT / '.tools/modlock-tools'
ADDON = 'bebop_wars'
SOURCE = ROOT / 'content/citadel_addons' / ADDON
OUTPUT = ROOT / '.local/compiled' / ADDON
PIN = 'b553b8e0ccffcbc18736cb607da1979cb8a47cc6'

def steam_root():
    for p in (Path.home()/'.local/share/Steam', Path.home()/'.steam/steam',
              Path.home()/'.var/app/com.valvesoftware.Steam/.local/share/Steam'):
        if (p/'steamapps').is_dir(): return p.resolve()
    return None

def check_sdk():
    if not (SDK/'scripts/install.py').is_file():
        raise SystemExit('Run git submodule update --init --recursive first.')
    revision=subprocess.check_output(['git','-C',str(SDK),'rev-parse','HEAD'],text=True).strip()
    if revision!=PIN: raise SystemExit('SDK revision differs from the project pin; review the upgrade first.')

def installed():
    try:
        state=json.loads((TOOLS/'.cache/installed.json').read_text())
        return bool(state.get('complete')) and (TOOLS/'game/bin/win64/sdk-launcher.exe').is_file()
    except (OSError,ValueError): return False

def link_addon():
    if not installed(): raise SystemExit('The toolkit install has not completed. Run install first.')
    pairs=[(TOOLS/'content/citadel_addons'/ADDON,SOURCE),
           (TOOLS/'game/citadel_addons'/ADDON,OUTPUT)]
    for destination,source in pairs:
        if destination.exists() or destination.is_symlink():
            if destination.resolve()!=source.resolve():
                raise SystemExit(f'Refusing to replace existing addon directory: {destination}')
    for destination,source in pairs:
        source.mkdir(parents=True,exist_ok=True)
        destination.parent.mkdir(parents=True,exist_ok=True)
        if not destination.is_symlink():destination.symlink_to(source,target_is_directory=True)

def windows_path(p):
    # Keep the toolkit's logical content path; resolving its addon symlink can
    # make the compiler infer the repository as a different content project.
    return 'Z:' + str(p.absolute()).replace('/','\\')

def run_tool(args, executable, tool_args):
    if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        raise SystemExit('Launch from your Linux desktop session; no display is set.')
    env=os.environ.copy()
    logs=ROOT/'.private/logs';logs.mkdir(parents=True,exist_ok=True,mode=0o700)
    if args.runtime=='proton':
        steam=steam_root()
        if not steam:raise SystemExit('No Steam installation found.')
        proton=(args.proton or steam/'steamapps/common/Proton - Experimental/proton').resolve()
        if not proton.is_file():raise SystemExit('Proton not found. Install Proton Experimental in Steam or pass --proton PATH.')
        compat=ROOT/'.local/proton';compat.mkdir(parents=True,exist_ok=True)
        env.update(STEAM_COMPAT_DATA_PATH=str(compat),STEAM_COMPAT_CLIENT_INSTALL_PATH=str(steam),
                   SteamAppId='0',SteamGameId='0',PROTON_LOG='1',PROTON_LOG_DIR=str(logs))
        command=[str(proton),'run',str(executable),*tool_args]
    else:
        wine=shutil.which('wine')
        if not wine:raise SystemExit('wine is not installed.')
        env.update(WINEPREFIX=str(ROOT/'.local/wine'),WINEARCH='win64')
        command=[wine,str(executable),*tool_args]
    print('Runtime:',args.runtime,'| Toolkit:',TOOLS,flush=True)
    return subprocess.call(command,cwd=TOOLS/'game/bin/win64',env=env)

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('action',choices=['doctor','install','link-addon','hammer','compile'])
    ap.add_argument('--runtime',choices=['proton','wine'],default='proton')
    ap.add_argument('--proton',type=Path,help='path to the Proton launcher script')
    ap.add_argument('--asset',help='addon-relative source path for compile, e.g. maps/bebop_wars.vmap')
    args=ap.parse_args();check_sdk()
    if args.action=='doctor':
        steam=steam_root()
        print(json.dumps({'project':str(ROOT),'sdk_revision':PIN,'toolkit_installed':installed(),
            'source':str(SOURCE),'compiled_output':str(OUTPUT),'steam':str(steam) if steam else None,
            'wine':shutil.which('wine'),'uv':shutil.which('uv'),
            'desktop':bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')),
            'gpu_device':Path('/dev/dri').exists()},indent=2));return 0
    if args.action=='install':
        uv=shutil.which('uv')
        if not uv:raise SystemExit('Install uv (https://docs.astral.sh/uv/) first.')
        TOOLS.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        return subprocess.call([uv,'run','--no-project','--python','3.14',str(SDK/'scripts/install.py'),
                                '--destination',str(TOOLS)],cwd=ROOT)
    link_addon()
    if args.action=='link-addon':print('Addon linked:',SOURCE);return 0
    if args.action=='hammer':
        sys.path.insert(0,str(SDK/'scripts'))
        flags=importlib.import_module('toolkit').EDITOR_ARGS
        return run_tool(args,TOOLS/'game/bin/win64/sdk-launcher.exe',
                        [*flags,'-addon',ADDON,'+show_tool','hammer'])
    if not args.asset:ap.error('compile requires --asset')
    asset=(SOURCE/args.asset).resolve()
    if not asset.is_relative_to(SOURCE.resolve()) or not asset.is_file():
        raise SystemExit('Asset must be an existing file inside this addon.')
    toolkit_asset=TOOLS/'content/citadel_addons'/ADDON/asset.relative_to(SOURCE.resolve())
    sys.path.insert(0,str(ROOT/'scripts/mapping'))
    from runtime import ensure_closed, prepare, workspace_lock
    with workspace_lock():
        if asset.suffix=='.vmap': ensure_closed(asset.stem)
        profile=prepare()
        flags=['-game',windows_path(profile),'-i',windows_path(toolkit_asset),'-nop4']
        flags+=['-fshallow','-world','-phys','-vis','-bakedlighting','-bakelighting'] if asset.suffix=='.vmap' else ['-f']
        return run_tool(args,TOOLS/'game/bin/win64/resourcecompiler.exe',flags)

if __name__=='__main__':
    raise SystemExit(main())
