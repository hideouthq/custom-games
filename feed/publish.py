#!/usr/bin/env python3
"""Publishes the custom games feed from a release: what is live decides the rest, and the bucket gets it in a safe order.

A release names the Modlock runtime's files, each mode's build folder and the upcoming listings. The tool reads the
live feed and checks its signature, takes the next sequence from it, builds the platform mod and takes the renderer
with the release's own Linux CLI, and writes the feed with make_feed.py, which applies every rule Hideout's parser does.
It prints what differs from the live feed and which files would be uploaded, in order.

With no --key it is a dry run: the feed is signed with a throwaway key and nothing leaves this computer. With --key and
--upload it puts the runtime files, packages and art in the bucket first and the feed and its signature last, then
reads the live feed back and checks its signature, its sequence and every file it names. --verify does only that check.
"""
import argparse
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse

HERE = Path(__file__).resolve().parent
# The feed and key Hideout trusts, CustomGamesFeedUrl.Default and CustomGamesFeedKey.Default in the app. A change to
# either ships in the app first.
FEED_URL = "https://hideouthq.gg/customgames/customgames.json"
FEED_KEY = "MCowBQYDK2VwAyEAhurl6iMAxAZhsvDzUl27iFpJphpy0RLVv0tHi3t8fyM="
PLATFORM_MOD = HERE / "platform-mod"
PLATFORM_FILES = ("main.ts", "mod.json", "tsconfig.json")
WRANGLER = ("npx", "--yes", "wrangler@4.148.0")
BUCKET = "hideout-customgames"
WRANGLER_LIMIT = 300 * 1024 ** 2
# The edge keeps the feed and its signature for up to 60 s each.
EDGE_WAIT = 180
RELEASE_FIELDS = {"modlock", "cli", "host", "modes", "upcoming"}

spec = importlib.util.spec_from_file_location("make_feed", HERE / "make_feed.py")
make_feed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make_feed)
Problem = make_feed.Problem


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "hideout-publish"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except (urllib.error.URLError, OSError) as e:
        raise Problem(f"cannot read {url}: {e}")


def served(url, method):
    request = urllib.request.Request(url, method=method, headers={"User-Agent": "hideout-publish"})
    try:
        return urllib.request.urlopen(request, timeout=120)
    except urllib.error.HTTPError as e:
        e.close()
        if e.code == 404:
            return None
        raise Problem(f"{url} answered {e.code}")
    except (urllib.error.URLError, OSError) as e:
        raise Problem(f"cannot reach {url}: {e}")


def served_size(url):
    response = served(url, "HEAD")
    if response is None:
        return None
    with response:
        return int(response.headers["Content-Length"])


def served_digest(url):
    response = served(url, "GET")
    if response is None:
        return None
    digest = hashlib.sha256()
    with response:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def already_served(url, path, named_by_digest):
    if named_by_digest:
        size = served_size(url)
        if size is None or size == path.stat().st_size:
            return size is not None
        theirs = f"{size} bytes"
    else:
        digest = served_digest(url)
        if digest is None or digest == make_feed.sha256(path):
            return digest is not None
        theirs = f"bytes with SHA-256 {digest}"
    raise Problem(f"{url} already serves {theirs}, not those of {path}, and a published file is never replaced")


def signature_holds(public_key, data, signature):
    with tempfile.TemporaryDirectory() as work:
        files = {name: Path(work) / name for name in ("key.der", "signature", "feed")}
        try:
            files["key.der"].write_bytes(base64.b64decode(public_key, validate=True))
            files["signature"].write_bytes(base64.b64decode(signature, validate=True))
        except ValueError:
            return False
        files["feed"].write_bytes(data)
        return make_feed.openssl("pkeyutl", "-verify", "-rawin", "-pubin", "-keyform", "DER", "-inkey", files["key.der"],
                                 "-sigfile", files["signature"], "-in", files["feed"]).returncode == 0


def read_signed(feed_url, public_key):
    text, signature = get(feed_url), get(f"{feed_url}.sig")
    if not signature_holds(public_key, text, signature):
        raise Problem(f"the signature at {feed_url}.sig does not verify with the key Hideout trusts, {public_key}")
    try:
        return text, signature, json.loads(text)
    except ValueError as e:
        raise Problem(f"{feed_url} is not JSON: {e}")


def artifacts(feed):
    runtime = feed["runtime"]
    named = [(f"cli {os}", entry) for os, entry in sorted(runtime["cli"].items())]
    named += [("host", runtime["host"]), ("platform", runtime["platform"]), ("renderer", runtime["renderer"])]
    for mode in feed["modes"]:
        named += [(f"{mode['id']} {part}", mode[part]) for part in ("rules", "client") if part in mode]
    return named


def art_urls(feed):
    listings = [mode["listing"] for mode in feed["modes"]] + [entry["listing"] for entry in feed.get("upcoming", [])]
    return sorted({url for listing in listings for url in make_feed.art_paths(listing.get("art", {}))})


def check_served(feed):
    for name, artifact in artifacts(feed):
        data = get(artifact["url"])
        if len(data) != artifact["bytes"] or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
            raise Problem(f"{name}: {artifact['url']} serves {len(data)} bytes with another digest than the feed names")
    for url in art_urls(feed):
        prefix = PurePosixPath(unquote(urlparse(url).path)).name.split("-", 1)[0]
        if not hashlib.sha256(get(url)).hexdigest().startswith(prefix):
            raise Problem(f"{url} serves a picture whose digest does not start with {prefix}")
    return len(artifacts(feed)), len(art_urls(feed))


def read_back(feed_url, public_key, text=None, signature=None, wait=EDGE_WAIT, pause=10):
    deadline = time.monotonic() + wait
    while True:
        served, served_signature, feed = read_signed(feed_url, public_key)
        if text is None or (served, served_signature) == (text, signature):
            break
        if time.monotonic() > deadline:
            raise Problem(f"{feed_url} still serves another feed or signature after {wait} s")
        time.sleep(pause)
    packages, pictures = check_served(feed)
    return f"Live feed sequence {feed['sequence']} verified: its signature, {packages} packages and {pictures} pictures."


def absolute(release, folder):
    def at(value):
        return str((folder / value).resolve())
    return {
        **release,
        "cli": {os: {**entry, "file": at(entry["file"])} for os, entry in release["cli"].items()},
        "host": {**release["host"], "file": at(release["host"]["file"])},
        "modes": [{**mode, "dir": at(mode["dir"])} for mode in release["modes"]],
        "upcoming": [{**entry, "listing": at(entry["listing"])} for entry in release.get("upcoming", [])],
    }


def read_release(path):
    release = make_feed.read_json(path)
    if not isinstance(release, dict):
        raise Problem(f"{path} is not a JSON object")
    problems = make_feed.unknown_fields("release", release, RELEASE_FIELDS)
    missing = sorted(RELEASE_FIELDS - {"upcoming"} - set(release))
    problems += [f"release: needs {field}" for field in missing]
    if not problems and not (isinstance(release["cli"], dict) and "linux" in release["cli"]):
        problems.append("release: cli needs linux, whose CLI builds the platform mod")
    if problems:
        raise Problem("; ".join(problems))
    return absolute(release, Path(path).resolve().parent)


def build_platform(cli, work):
    program = work / "modlock"
    shutil.copyfile(cli, program)
    program.chmod(program.stat().st_mode | stat.S_IXUSR)
    folder = work / "platform-mod"
    folder.mkdir()
    for name in PLATFORM_FILES:
        shutil.copyfile(PLATFORM_MOD / name, folder / name)
    env = {**os.environ, "XDG_CACHE_HOME": str(work / "cache"), "XDG_CONFIG_HOME": str(work / "config"), "MODLOCK_NO_UPDATE_CHECK": "1"}
    result = subprocess.run([program, "build"], cwd=folder, env=env, capture_output=True, text=True)
    if result.returncode:
        raise Problem(f"the release's Linux CLI could not build the platform mod: {(result.stdout + result.stderr).strip()}")
    # The CLI unpacks its own built library, renderer included, the first time it builds a script mod.
    libraries = list((work / "cache/modlock/library").glob("built-*"))
    if len(libraries) != 1:
        raise Problem(f"the release's Linux CLI unpacked {len(libraries)} libraries instead of one")
    renderer = work / "renderer"
    renderer.mkdir()
    for name in make_feed.RENDERER_FILES:
        shutil.copyfile(libraries[0] / name, renderer / name)
    return folder / "build", renderer


def describe(live, feed):
    def change(old, new, parts):
        if old is None:
            return "new"
        changed = [part for part in parts if old.get(part) != new.get(part)]
        return f"{', '.join(changed)} changed" if changed else "unchanged"

    def files(runtime):
        return [runtime.get("host"), *(entry for _, entry in sorted(runtime.get("cli", {}).items()))]

    runtime, was = feed["runtime"], live.get("runtime", {})
    if files(runtime) == files(was):
        lines = [f"runtime {runtime['modlock']}: unchanged"]
    elif runtime["modlock"] == was.get("modlock"):
        lines = [f"runtime {runtime['modlock']}: its files changed under the same version"]
    else:
        lines = [f"runtime {runtime['modlock']}: was {was.get('modlock')}"]
    lines += [f"{part}: " + ("unchanged" if runtime[part] == was.get(part) else "changed") for part in ("platform", "renderer")]
    old_modes = {mode["id"]: mode for mode in live.get("modes", [])}
    for mode in feed["modes"]:
        lines.append(f"{mode['id']} {mode['version']}: {change(old_modes.get(mode['id']), mode, ('version', 'rules', 'client', 'listing'))}")
    lines += [f"{name}: removed" for name in old_modes if name not in {mode['id'] for mode in feed['modes']}]
    old_upcoming = {entry["id"]: entry for entry in live.get("upcoming", [])}
    for entry in feed["upcoming"]:
        lines.append(f"upcoming {entry['id']}: {change(old_upcoming.get(entry['id']), entry, ('listing',))}")
    lines += [f"upcoming {name}: removed" for name in old_upcoming if name not in {entry['id'] for entry in feed['upcoming']}]
    return lines


def uploads(feed, release, out, base):
    runtime = feed["runtime"]
    planned = [(runtime["cli"][os]["url"], Path(release["cli"][os]["file"]), False) for os in sorted(runtime["cli"])]
    planned.append((runtime["host"]["url"], Path(release["host"]["file"]), False))
    planned += [(artifact["url"], out / unquote(artifact["url"].removeprefix(f"{base}/")), True) for _, artifact in artifacts(feed)
                if not artifact["url"].startswith(f"{base}/runtime/")]
    planned += [(url, out / unquote(url.removeprefix(f"{base}/")), True) for url in art_urls(feed)]
    result = [(unquote(url.removeprefix(f"{base}/")), path, already_served(url, path, by_digest)) for url, path, by_digest in planned]
    return result + [("customgames.json", out / "customgames.json", False), ("customgames.json.sig", out / "customgames.json.sig", False)]


def wrangler_put(key, path):
    if not shutil.which(WRANGLER[0]):
        raise Problem("uploads run Wrangler through npx, so install Node.js first")
    subprocess.run([*WRANGLER, "r2", "object", "put", f"{BUCKET}/{key}", "--file", str(path), "--remote"], check=True)


def upload(planned):
    for key, path, live in planned:
        if not live:
            print(f"Uploading {key}", flush=True)
            wrangler_put(key, path)


def size_text(size):
    return f"{size / 1024 ** 2:.1f} MiB" if size >= 1024 ** 2 else f"{size / 1024:.0f} KiB"


def publish(args):
    release = read_release(args.release)
    base = args.feed_url.rsplit("/", 1)[0]
    elsewhere = [entry["url"] for entry in (*release["cli"].values(), release["host"]) if not entry["url"].startswith(f"{base}/runtime/")]
    if elsewhere:
        raise Problem(f"the runtime's files are published under {base}/runtime/, and {', '.join(elsewhere)} is not")
    live_text, _, live = read_signed(args.feed_url, args.public_key)
    out = Path(args.out).resolve()
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        platform, renderer = build_platform(release["cli"]["linux"]["file"], work)
        (work / "source.json").write_text(json.dumps({**release, "platform": str(platform), "renderer": str(renderer)}))
        (work / "live.json").write_bytes(live_text)
        if args.key:
            key, signing = args.key, args.public_key
        else:
            key = work / "throwaway.pem"
            with contextlib.redirect_stdout(None):
                make_feed.generate_test_key(key)
            signing = make_feed.public_key_of(key)
        arguments = ["--source", str(work / "source.json"), "--sequence", str(live["sequence"] + 1), "--previous", str(work / "live.json"),
                     "--key", str(key), "--public-key", signing, "--base-url", base, "--out", str(out)]
        if make_feed.main(arguments + (["--allow-http"] if args.allow_http else [])):
            raise Problem("make_feed refused the release, for the reasons above")
    feed = json.loads((out / "customgames.json").read_text())
    planned = uploads(feed, release, out, base)
    print(f"Live feed: sequence {live['sequence']}, runtime {live['runtime']['modlock']}, signature verified.")
    print(f"New feed: sequence {feed['sequence']}, in {out}")
    print("\n".join(f"  {line}" for line in describe(live, feed)))
    print(f"Upload to {BUCKET}, in this order:")
    waiting = [(key, path) for key, path, live_now in planned if not live_now]
    for index, (key, path) in enumerate(waiting, 1):
        print(f"  {index}. {key}  {size_text(path.stat().st_size)}")
    print(f"Already served and left alone: {len(planned) - len(waiting)} files.")
    too_big = [key for key, path in waiting if path.stat().st_size > WRANGLER_LIMIT]
    if too_big:
        raise Problem(f"Wrangler uploads at most 300 MiB an object, so put {', '.join(too_big)} through R2's S3 API, then run this again")
    if not args.upload:
        print("Dry run: nothing was uploaded." + ("" if args.key else f" The feed is signed with a throwaway key whose public half is {signing}."))
        return
    upload(planned)
    print(read_back(args.feed_url, args.public_key, (out / "customgames.json").read_bytes(), (out / "customgames.json.sig").read_bytes()))


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", help="the JSON file naming the runtime's files, the modes' build folders and the upcoming listings")
    parser.add_argument("--out", help="a new or empty folder for the feed and everything it publishes")
    parser.add_argument("--key", help="the feed's private key; without it the feed is signed with a throwaway key and nothing is uploaded")
    parser.add_argument("--upload", action="store_true", help="upload in order and read the live feed back; needs --key")
    parser.add_argument("--verify", action="store_true", help="only check the live feed, its signature and every file it names")
    parser.add_argument("--feed-url", default=None, help="the live feed (default: the one Hideout reads); not with --upload")
    parser.add_argument("--public-key", default=None, help="the key the live feed is checked with (default: the one Hideout trusts); not with --upload")
    parser.add_argument("--allow-http", action="store_true", help="let a local test feed be http; not with --upload")
    args = parser.parse_args(argv)
    if not args.verify:
        if not (args.release and args.out):
            parser.error("--release and --out are required, unless --verify")
        if args.upload and not args.key:
            parser.error("--upload needs --key, the feed's own key")
        if args.upload and (args.feed_url or args.public_key or args.allow_http):
            parser.error("--upload writes the feed the app reads, so it takes no --feed-url, --public-key or --allow-http")
    args.feed_url = args.feed_url or FEED_URL
    args.public_key = args.public_key or FEED_KEY
    return args


def main(argv=None):
    args = parse_args(argv)
    try:
        if args.verify:
            print(read_back(args.feed_url, args.public_key))
        else:
            publish(args)
    except Problem as e:
        print(f"publish: {e}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as e:
        print(f"publish: {' '.join(map(str, e.cmd[:5]))} failed with status {e.returncode}, and nothing after it was uploaded", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
