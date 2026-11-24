#!/usr/bin/env python3
"""Turns a source file and built Modlock mods into the files a custom games feed publishes.

Writes OUT/customgames.json (the feed Hideout reads), OUT/customgames.json.sig, one zip per package and OUT/art. Each
mode's listing is the hideout.json in its build folder, the same file Hideout reads when its author hosts the folder. The
feed has its own Ed25519 key, never the release key. --generate-test-key writes a key for a local test feed and prints its public half.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from datetime import date
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlparse

SCHEMA = 2
MAX_ARTIFACT_BYTES = 8 * 1024 ** 3
MAX_PLAYERS = 64
MAX_SEQUENCE = 2 ** 63 - 1
OPERATING_SYSTEMS = {"linux", "windows"}
RELEASE_PUBLIC_KEY = "MCowBQYDK2VwAyEAKkjHdRhvoz4Mrt696uEkV5+XBfmnRU2amsyxY0GpwMo="
MODE_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
SHA256 = re.compile(r"[0-9a-f]{64}")
FILE_NAME_PART = re.compile(r"[A-Za-z0-9._+-]+")
TOKEN = re.compile(r"[a-z0-9_-]{1,16}")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
CONTROL = re.compile("[\x00-\x1f\x7f-\x9f]")
HEX_COLOR = re.compile(r"#[0-9A-Fa-f]{6}")
PLACEHOLDER = re.compile(r"\{([a-z0-9_-]{1,16})\}")
ZIP_TIME = (1980, 1, 1, 0, 0, 0)

SOURCE_FIELDS = {"modlock", "cli", "host", "platform", "renderer", "modes"}
UPSTREAM_FIELDS = {"url", "file", "sha256"}
MODE_FIELDS = {"id", "dir"}
LISTING = "hideout.json"
ART_FIELDS = ("card", "backdrop", "render", "overlay", "tile", "explainer")

# The folders Modlock's own publish step takes from a built mod (publish/mod.go in paralin/modlock).
CONTENT_FOLDERS = ("panorama", "models", "materials", "particles")
RENDERER_FILES = ("layout.js", "renderer.js")
DATA_FOLDER = "data"


class Problem(Exception):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def text_field(holder, field):
    value = holder.get(field)
    return isinstance(value, str) and bool(value.strip())


def unknown_fields(where, holder, known):
    return [f"{where}: unknown field {field}" for field in sorted(set(holder) - known)]


def inside(name):
    return isinstance(name, str) and bool(name) and not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts and "\\" not in name


def relative_file(folder, name):
    if not inside(name):
        raise Problem(f"{folder}: {name!r} is not a path inside the folder")
    return str(PurePosixPath(name))


def text(value, most, lines=False):
    if not isinstance(value, str):
        return False
    trimmed = value.strip()
    return 0 < len(trimmed) <= most and not CONTROL.search(trimmed.replace("\n", "") if lines else trimmed)


def span(value, most):
    return isinstance(value, dict) and type(value.get("min")) is int and type(value.get("max")) is int and 1 <= value["min"] <= value["max"] <= most


def every(value, most, check):
    return isinstance(value, list) and len(value) <= most and all(map(check, value))


def is_date(value):
    try:
        return isinstance(value, str) and bool(DATE.fullmatch(value)) and bool(date.fromisoformat(value))
    except ValueError:
        return False


def art_paths(art):
    return [art[field] for field in ART_FIELDS if art.get(field) is not None] + list(art.get("screenshots", []))


def setting_problem(setting, players):
    """A setting with no options is skipped, as a later Hideout may draw it."""
    if not (isinstance(setting, dict) and isinstance(setting.get("key"), str) and isinstance(setting.get("label"), str)):
        return "needs a key and a label"
    options = setting.get("options")
    if options is None:
        return None
    if not (isinstance(options, list) and 2 <= len(options) <= 5 and all(isinstance(option, dict) for option in options)):
        return "needs 2 to 5 options"
    values = [option.get("value") for option in options]
    sizes = [option.get("players") for option in options if option.get("players") is not None]
    rules = (
        (TOKEN.fullmatch(setting["key"]), "its key must match [a-z0-9_-]{1,16}"),
        (text(setting["label"], 32), "its label must be text of at most 32"),
        (setting.get("hint") is None or text(setting["hint"], 80), "its hint must be text of at most 80"),
        (all(isinstance(v, str) and TOKEN.fullmatch(v) for v in values), "each option's value must match [a-z0-9_-]{1,16}"),
        (len(set(map(str, values))) == len(values), "its options' values must differ"),
        (all(text(option.get("label"), 24) for option in options), "each option's label must be text of at most 24"),
        (setting.get("default") in values, "its default must be one of its options' values"),
        (not sizes or (len(sizes) == len(options) and all(type(n) is int and players["min"] <= n <= players["max"] for n in sizes)),
         "players must be on every option or none, each within the listing's players"),
    )
    return next((rule for ok, rule in rules if not ok), None)


def step(value):
    return isinstance(value, dict) and text(value.get("title"), 48) and text(value.get("body"), 300) and (value.get("icon") is None or isinstance(value["icon"], str))


def legend_entry(value):
    return isinstance(value, dict) and text(value.get("label"), 48) and isinstance(value.get("color"), str) and bool(HEX_COLOR.fullmatch(value["color"]))


def fact(value):
    return isinstance(value, dict) and text(value.get("label"), 24) and text(value.get("value"), 48) and (value.get("note") is None or text(value["note"], 48))


def listing_problems(listing):
    """The rules Hideout's parseListing holds a listing to."""
    if not isinstance(listing, dict):
        return ["is not a JSON object"]
    art = listing.get("art", {})
    rules = (
        ("name", text(listing.get("name"), 48), "text of 1 to 48 characters with no control characters"),
        ("tagline", text(listing.get("tagline"), 120), "text of 1 to 120 characters with no control characters"),
        ("description", text(listing.get("description"), 2000, lines=True), "text of 1 to 2000 characters with no control characters"),
        ("players", span(listing.get("players"), MAX_PLAYERS), f"a min and a max with 1 <= min <= max <= {MAX_PLAYERS}"),
        ("creators", every(listing.get("creators"), 8, lambda c: text(c, 48)) and listing["creators"], "1 to 8 names of at most 48 characters"),
        ("released", is_date(listing.get("released")), "a date, YYYY-MM-DD"),
        ("kind", listing.get("kind") is None or isinstance(listing["kind"], str), "text"),
        ("minutes", listing.get("minutes") is None or span(listing["minutes"], 600), "a min and a max with 1 <= min <= max <= 600"),
        ("curated", isinstance(listing.get("curated", False), bool), "true or false"),
        ("checkedOn", listing.get("checkedOn") is None or (type(listing["checkedOn"]) is int and listing["checkedOn"] > 0),
         "the game's SourceRevision from steam.inf, a positive integer"),
        ("howToPlay", every(listing.get("howToPlay", []), 3, step),
         "at most 3 steps, each a title of at most 48 characters, a body of at most 300, and an icon's name or none"),
        ("whatsNew", every(listing.get("whatsNew", []), 8, lambda line: text(line, 200)), "at most 8 lines of at most 200 characters"),
        ("art", isinstance(art, dict) and all(art.get(field) is None or inside(art[field]) for field in ART_FIELDS)
         and every(art.get("screenshots", []), 8, inside),
         f"{', '.join(ART_FIELDS)} and at most 8 screenshots, each a path inside the build folder"),
        ("settings", isinstance(listing.get("settings", []), list), "a list"),
        ("sections", isinstance(listing.get("sections", []), list) and all(isinstance(name, str) for name in listing.get("sections", [])), "a list of names"),
        ("summary", listing.get("summary") is None or text(listing["summary"], 200), "text of 1 to 200 characters with no control characters"),
        ("legend", every(listing.get("legend", []), 6, legend_entry), "at most 6 entries, each a label of at most 48 characters and a color #RRGGBB"),
        ("facts", every(listing.get("facts", []), 4, fact), "at most 4 facts, each a label of at most 24 characters, a value of at most 48 and a note of at most 48 or none"),
        ("goal", listing.get("goal") is None or text(listing["goal"], 48), "text of 1 to 48 characters with no control characters"),
    )
    problems = [f"{field} must be {rule}" for field, ok, rule in rules if not ok]
    if problems:
        return problems
    for index, setting in enumerate(listing.get("settings", [])):
        if problem := setting_problem(setting, listing["players"]):
            problems.append(f"setting {setting.get('key', index) if isinstance(setting, dict) else index}: {problem}")
    if problems:
        return problems
    read = [setting for setting in listing.get("settings", []) if setting.get("options") is not None]
    keys = [setting["key"] for setting in read]
    if len(read) > 4:
        problems.append("settings: at most 4 with options")
    if len(set(keys)) != len(keys):
        problems.append("settings: each key once")
    if sum(any(option.get("players") is not None for option in setting["options"]) for setting in read) > 1:
        problems.append("settings: only one may set players")
    return problems + goal_problems(listing.get("goal"), set(keys))


def goal_problems(goal, keys):
    """A goal may name a setting as {key}, which Hideout fills with the picked option's label."""
    if goal is None:
        return []
    rest = PLACEHOLDER.sub("", goal)
    if "{" in rest or "}" in rest:
        return ["goal may hold { and } only around a setting's key"]
    return [f"goal names {{{key}}}, which is no setting with options" for key in sorted(set(PLACEHOLDER.findall(goal)) - keys)]


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as e:
        raise Problem(f"cannot read {path}: {e.strerror}")
    except ValueError as e:
        raise Problem(f"{path} is not valid JSON: {e}")


def read_manifest(folder):
    manifest = read_json(folder / "mod.json")
    if not (isinstance(manifest, dict) and text_field(manifest, "slug") and text_field(manifest, "version") and text_field(manifest, "entry")):
        raise Problem(f"{folder / 'mod.json'} needs a slug, a version and an entry")
    return manifest


def refuse_links(paths):
    for path in paths:
        if path.is_symlink():
            raise Problem(f"{path} is a symbolic link, and a package holds only files")


def regular_files(folder, top):
    names = []
    for current, directories, files in os.walk(folder / top):
        refuse_links(Path(current) / name for name in directories)
        names += [(Path(current) / name).relative_to(folder).as_posix() for name in files]
    return names


def package_lists(folder):
    manifest = read_manifest(folder)
    required = ["mod.json", relative_file(folder, manifest["entry"])]
    for name in required:
        if not (folder / name).is_file():
            raise Problem(f"{folder / name} is missing or is not a file")
    refuse_links(folder / top for top in (*CONTENT_FOLDERS, DATA_FOLDER))
    content = []
    if manifest.get("map"):
        map_name = relative_file(folder, manifest["map"])
        content += [f"maps/{map_name}{extension}" for extension in (".vpk", ".bsp") if (folder / "maps" / f"{map_name}{extension}").is_file()]
    for top in CONTENT_FOLDERS:
        content += regular_files(folder, top)
    # Modlock mounts any content it finds in a mod, over the block that carries the renderer.
    host = sorted({*required, *(name for name in content if name.endswith(".bsp")), *regular_files(folder, DATA_FOLDER)})
    notice = folder / "LICENSE"
    refuse_links([notice])
    if notice.is_file():
        host = sorted({*host, "LICENSE"})
        if content:
            content.append("LICENSE")
    refuse_links(folder / name for name in [*host, *content])
    return host, sorted(content)


def write_zip(folder, names, target):
    with zipfile.ZipFile(target, "w") as archive:
        for name in names:
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.file_size = (folder / name).stat().st_size
            with (folder / name).open("rb") as source, archive.open(info, "w") as entry:
                while chunk := source.read(1024 * 1024):
                    entry.write(chunk)


def artifact(url, path):
    size = path.stat().st_size
    if not 1 <= size <= MAX_ARTIFACT_BYTES:
        raise Problem(f"{path} is {size} bytes, which the feed's limit of 1 to {MAX_ARTIFACT_BYTES} refuses")
    return {"url": url, "bytes": size, "sha256": sha256(path)}


def package(folder, names, label, out, base):
    with tempfile.NamedTemporaryFile(dir=out, delete=False) as temp:
        staged = Path(temp.name)
    try:
        write_zip(folder, names, staged)
        name = f"{label}-{sha256(staged)[:12]}.zip"
        staged.chmod(0o644)
        staged.replace(out / name)
    finally:
        staged.unlink(missing_ok=True)
    return artifact(f"{base}/{quote(name)}", out / name)


def resolve(source_dir, text):
    return (source_dir / text).resolve()


def upstream_problems(where, entry, modlock, source_dir, schemes):
    if not isinstance(entry, dict):
        return [f"{where}: needs a url and a file"]
    problems = unknown_fields(where, entry, UPSTREAM_FIELDS)
    if not (text_field(entry, "url") and text_field(entry, "file")):
        return problems + [f"{where}: needs a url and a file"]
    url = urlparse(entry["url"])
    path = resolve(source_dir, entry["file"])
    if url.scheme not in schemes:
        problems.append(f"{where}: {entry['url']} is not https")
    if f"/{modlock}/" not in url.path:
        problems.append(f"{where}: {entry['url']} is not under Modlock {modlock}")
    if PurePosixPath(url.path).name != path.name:
        problems.append(f"{where}: the url names {PurePosixPath(url.path).name} but the file is {path.name}")
    if not path.is_file():
        return problems + [f"{where}: no file at {path}"]
    if "sha256" in entry:
        if not (isinstance(entry["sha256"], str) and SHA256.fullmatch(entry["sha256"])):
            problems.append(f"{where}: sha256 is not 64 lower-case hex digits")
        elif sha256(path) != entry["sha256"]:
            problems.append(f"{where}: {path} has SHA-256 {sha256(path)} instead of {entry['sha256']}")
    return problems


def id_problems(where, value):
    if isinstance(value, str) and MODE_ID.fullmatch(value):
        return []
    return [f"{where}: id {value!r} must be lower-case letters, digits, '.', '_' or '-', at most 64"]


def mode_problems(where, mode, source_dir):
    if not isinstance(mode, dict):
        return [f"{where}: is not an object"]
    problems = unknown_fields(where, mode, MODE_FIELDS) + id_problems(where, mode.get("id"))
    if not text_field(mode, "dir"):
        problems.append(f"{where}: needs a dir")
    if problems:
        return problems
    folder = resolve(source_dir, mode["dir"])
    package_lists(folder)
    manifest = read_manifest(folder)
    if manifest["slug"] != mode["id"]:
        problems.append(f"{where}: its build's slug is {manifest['slug']}, not {mode['id']}")
    if not FILE_NAME_PART.fullmatch(manifest["version"]):
        problems.append(f"{where}: version {manifest['version']!r} names files, so it holds only letters, digits, '.', '_', '+' and '-'")
    listing = read_json(folder / LISTING)
    problems += [f"{where}: {LISTING} {problem}" for problem in listing_problems(listing)]
    return problems or art_problems(where, folder, listing)


def art_problems(where, folder, listing):
    return [f"{where}: {folder / path} is missing, or is not a file in the build folder" for path in art_paths(listing.get("art", {}))
            if not ((folder / path).is_file() and (folder / path).resolve().is_relative_to(folder))]


def source_problems(source, source_dir, schemes):
    if not isinstance(source, dict):
        return ["the source file is not a JSON object"]
    problems = unknown_fields("source", source, SOURCE_FIELDS)
    modlock = source.get("modlock")
    if not text_field(source, "modlock"):
        return problems + ["source: needs a modlock version"]
    cli = source.get("cli")
    if not (isinstance(cli, dict) and cli):
        problems.append("source: cli must name at least one operating system")
    else:
        problems += [f"cli: {name} is not one of {', '.join(sorted(OPERATING_SYSTEMS))}" for name in sorted(set(cli) - OPERATING_SYSTEMS)]
        for name in sorted(set(cli) & OPERATING_SYSTEMS):
            problems += upstream_problems(f"cli {name}", cli[name], modlock, source_dir, schemes)
    problems += upstream_problems("host", source.get("host"), modlock, source_dir, schemes)
    if text_field(source, "platform"):
        platform = resolve(source_dir, source["platform"])
        package_lists(platform)
        if not FILE_NAME_PART.fullmatch(read_manifest(platform)["version"]):
            problems.append(f"platform: the version in {platform / 'mod.json'} holds a character a file name cannot")
    else:
        problems.append("source: needs a platform folder")
    if text_field(source, "renderer"):
        renderer = resolve(source_dir, source["renderer"])
        problems += [f"renderer: {renderer / name} is missing or is not a file" for name in RENDERER_FILES if not (renderer / name).is_file() or (renderer / name).is_symlink()]
    else:
        problems.append("source: needs a renderer folder")
    modes = source.get("modes")
    if not isinstance(modes, list):
        return problems + ["source: modes is not a list"]
    for index, mode in enumerate(modes):
        problems += mode_problems(f"mode {mode.get('id', index) if isinstance(mode, dict) else index}", mode, source_dir)
    ids = [mode.get("id") for mode in modes if isinstance(mode, dict)]
    problems += [f"mode {name}: listed twice" for name in sorted({i for i in ids if isinstance(i, str) and ids.count(i) > 1})]
    return problems


def upstream_artifact(entry, source_dir):
    return artifact(entry["url"], resolve(source_dir, entry["file"]))


def published_listing(path, out, base):
    folder = path.parent
    listing = read_json(path)
    art = listing.get("art")
    if not art:
        return listing
    urls = {}
    (out / "art").mkdir(exist_ok=True)
    for path in art_paths(art):
        name = f"{sha256(folder / path)[:12]}-{PurePosixPath(path).name}"
        shutil.copyfile(folder / path, out / "art" / name)
        (out / "art" / name).chmod(0o644)
        urls[path] = f"{base}/art/{quote(name)}"
    named = {field: urls[art[field]] for field in ART_FIELDS if art.get(field) is not None}
    return {**listing, "art": {**art, **named, **({"screenshots": [urls[path] for path in art["screenshots"]]} if "screenshots" in art else {})}}


def build_mode(mode, source_dir, out, base):
    folder = resolve(source_dir, mode["dir"])
    host_files, client_files = package_lists(folder)
    version = read_manifest(folder)["version"]
    written = {"id": mode["id"], "version": version, "listing": published_listing(folder / LISTING, out, base)}
    label = f"{mode['id']}-{version}"
    written["rules"] = package(folder, host_files, f"rules-{label}", out, base)
    if client_files:
        written["client"] = package(folder, client_files, f"client-{label}", out, base)
    return written


def build_feed(source, source_dir, sequence, out, base):
    platform = resolve(source_dir, source["platform"])
    platform_files, _ = package_lists(platform)
    platform_version = read_manifest(platform)["version"]
    return {
        "schema": SCHEMA,
        "sequence": sequence,
        "runtime": {
            "modlock": source["modlock"],
            "cli": {name: upstream_artifact(entry, source_dir) for name, entry in sorted(source["cli"].items())},
            "host": upstream_artifact(source["host"], source_dir),
            "platform": package(platform, platform_files, f"platform-{platform_version}", out, base),
            "renderer": package(resolve(source_dir, source["renderer"]), list(RENDERER_FILES), f"renderer-{source['modlock']}", out, base),
        },
        "modes": [build_mode(mode, source_dir, out, base) for mode in source["modes"]],
    }


def openssl(*arguments):
    return subprocess.run(["openssl", *map(str, arguments)], capture_output=True)


def public_key_of(key):
    """The key's public half as the base64 of its DER, the form Hideout pins."""
    if not os.access(key, os.R_OK):
        raise Problem(f"cannot read the key file {key}")
    pem = openssl("pkey", "-in", key, "-pubout")
    if pem.returncode != 0:
        raise Problem(f"{key} is not a readable private key")
    der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "DER"], input=pem.stdout, capture_output=True, check=True)
    return base64.b64encode(der.stdout).decode()


def key_problems(key, trusted):
    actual = public_key_of(key)
    if actual == RELEASE_PUBLIC_KEY:
        return [f"{key} is the release key, and the custom games feed has its own"]
    if actual != trusted:
        return [f"{key} does not match --public-key, so every installed copy would refuse this feed (its public key is {actual})"]
    return []


def sign(key, feed):
    """A base64 Ed25519 signature on one line with no newline, over the feed's exact bytes, as sign_feed.sh writes it."""
    with tempfile.TemporaryDirectory() as work:
        raw = Path(work) / "raw"
        public = Path(work) / "public.pem"
        if openssl("pkeyutl", "-sign", "-rawin", "-inkey", key, "-in", feed, "-out", raw).returncode != 0:
            raise Problem(f"openssl could not sign {feed}")
        if raw.stat().st_size != 64:
            raise Problem(f"the signature is not 64 bytes, so {key} is not Ed25519")
        if openssl("pkey", "-in", key, "-pubout", "-out", public).returncode != 0:
            raise Problem(f"openssl could not read {key}")
        if openssl("pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", public, "-sigfile", raw, "-in", feed).returncode != 0:
            raise Problem("the new signature does not verify")
        Path(f"{feed}.sig").write_bytes(base64.b64encode(raw.read_bytes()))


def generate_test_key(path):
    # Created first with no access for anyone else, so the key is never readable under a wider mode.
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    result = openssl("genpkey", "-algorithm", "ed25519", "-out", path)
    if result.returncode != 0:
        os.unlink(path)
        raise Problem(f"openssl could not generate a key: {result.stderr.decode().strip()}")
    print(public_key_of(path))


def previous_problems(path, sequence):
    try:
        previous = read_json(path)
    except Problem as e:
        return [str(e)]
    last = previous.get("sequence") if isinstance(previous, dict) else None
    if type(last) is not int:
        return [f"{path} has no sequence"]
    if sequence <= last:
        return [f"sequence {sequence} is not higher than {last} in {path}, so Hideout would refuse this feed as a rollback"]
    return []


def read_source(path):
    try:
        return read_json(path), []
    except Problem as e:
        return None, [str(e)]


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate-test-key", metavar="PATH", help="write a new key for a local test feed to PATH, print its public half, and do nothing else")
    parser.add_argument("--source", help="the JSON file naming the Modlock files and the built mods; its paths are relative to it")
    parser.add_argument("--sequence", type=int, help="this feed's number, higher than any feed before it")
    parser.add_argument("--previous", help="the feed published before this one")
    parser.add_argument("--key", help="the feed's private key file")
    parser.add_argument("--public-key", help="the base64 DER public key Hideout trusts for this feed")
    parser.add_argument("--base-url", help="where the zips will be served")
    parser.add_argument("--allow-http", action="store_true", help="let --base-url be http, for a local test feed")
    parser.add_argument("--out", help="an empty or new folder, since all of it gets published")
    args = parser.parse_args(argv)
    if not args.generate_test_key:
        missing = [flag for flag, value in (("--source", args.source), ("--sequence", args.sequence), ("--key", args.key),
                                            ("--public-key", args.public_key), ("--base-url", args.base_url), ("--out", args.out)) if value is None]
        if missing:
            parser.error(f"{', '.join(missing)} required")
    return args


def schemes(args):
    return ("https", "http") if args.allow_http else ("https",)


def argument_problems(args):
    problems = []
    if not 1 <= args.sequence <= MAX_SEQUENCE:
        problems.append(f"sequence {args.sequence} must be positive")
    elif args.previous:
        problems += previous_problems(args.previous, args.sequence)
    if urlparse(args.base_url).scheme not in schemes(args):
        problems.append(f"--base-url {args.base_url} must be https{'' if args.allow_http else ', or http with --allow-http for a local test feed'}")
    out = Path(args.out)
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        problems.append(f"{out} must be an empty or new folder, since all of it gets published")
    return problems


def publish(args):
    source, problems = read_source(args.source)
    problems += argument_problems(args)
    problems += key_problems(args.key, args.public_key)
    source_dir = Path(args.source).resolve().parent
    if source is not None:
        problems += source_problems(source, source_dir, schemes(args))
    if problems:
        return problems
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    document = build_feed(source, source_dir, args.sequence, out, args.base_url.rstrip("/"))
    feed = out / "customgames.json"
    feed.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    sign(args.key, feed)
    return []


def main(argv=None):
    args = parse_args(argv)
    try:
        if args.generate_test_key:
            generate_test_key(args.generate_test_key)
            problems = []
        else:
            problems = publish(args)
    except FileExistsError as e:
        problems = [f"{e.filename} already exists, and a key is never overwritten"]
    except Problem as e:
        problems = [str(e)]
    for problem in problems:
        print(f"make_feed: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
