#!/usr/bin/env python3
import functools
import importlib.util
import io
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
LISTINGS = HERE / "testdata" / "listings"

spec = importlib.util.spec_from_file_location("publish", HERE / "publish.py")
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
make_feed = publish.make_feed

# Stands in for the release's Linux CLI: builds a script mod and unpacks its library, renderer included, as Modlock does.
FAKE_CLI = """#!/bin/sh
set -e
[ "$1" = build ] || exit 3
mkdir -p build "$XDG_CACHE_HOME/modlock/library/built-0123456789abcdef"
sed 's/}$/, "entry": "mod.js"}/' mod.json > build/mod.json
cat main.ts > build/mod.js
echo 'renderer of the release' > "$XDG_CACHE_HOME/modlock/library/built-0123456789abcdef/renderer.js"
echo 'layout of the release' > "$XDG_CACHE_HOME/modlock/library/built-0123456789abcdef/layout.js"
"""


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def write(path, text="x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


class Fixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        self.bucket = self.dir / "site/customgames"
        self.bucket.mkdir(parents=True)
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(self.dir / "site")))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_address[1]}/customgames"
        self.key = self.dir / "feed-key.pem"
        with redirect_stdout(io.StringIO()):
            make_feed.generate_test_key(self.key)
        self.public_key = make_feed.public_key_of(self.key)
        for patched in (patch.object(publish, "FEED_URL", f"{self.base}/customgames.json"),
                        patch.object(publish, "FEED_KEY", self.public_key), patch.object(publish, "wrangler_put", self.put),
                        patch.object(make_feed, "schemes", lambda args: ("https", "http"))):
            patched.start()
            self.addCleanup(patched.stop)
        self.put_keys = []
        self.release = self.write_release()
        self.go_live(sequence=7)

    def write_release(self):
        cli = write(self.dir / "runtime/modlock-linux-amd64", FAKE_CLI)
        write(self.dir / "runtime/modlock-windows-amd64.exe", "windows cli")
        write(self.dir / "runtime/modlock-host-windows-x64.zip", "host bundle")
        cli.chmod(0o644)
        mode = self.dir / "modes/arena"
        write(mode / "mod.json", json.dumps({"slug": "arena", "version": "1.0.0", "entry": "mod.js", "map": "arena"}))
        write(mode / "mod.js", "// arena\n")
        write(mode / "maps/arena.vpk", "map")
        write(mode / "hideout.json", json.dumps({**json.loads((LISTINGS / "valid/minimal.json").read_text()), "art": {"card": "art/card.png"}}))
        write(mode / "art/card.png", "card pixels")
        runtime = f"{self.base}/runtime/v1"
        release = {
            "modlock": "v1",
            "cli": {"linux": {"url": f"{runtime}/modlock-linux-amd64", "file": "runtime/modlock-linux-amd64"},
                    "windows": {"url": f"{runtime}/modlock-windows-amd64.exe", "file": "runtime/modlock-windows-amd64.exe"}},
            "host": {"url": f"{runtime}/modlock-host-windows-x64.zip", "file": "runtime/modlock-host-windows-x64.zip"},
            "modes": [{"id": "arena", "dir": "modes/arena"}],
        }
        return write(self.dir / "release.json", json.dumps(release))

    def go_live(self, sequence):
        artifact = {"url": f"{self.base}/old.zip", "bytes": 3, "sha256": "0" * 64}
        feed = write(self.bucket / "customgames.json", json.dumps({"schema": 2, "sequence": sequence, "runtime": {
            "modlock": "v0", "cli": {"linux": artifact}, "host": artifact, "platform": artifact, "renderer": artifact}, "modes": []}))
        make_feed.sign(self.key, feed)

    def put(self, key, path):
        self.put_keys.append(key)
        target = self.bucket / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)

    def run_tool(self, *extra, out="out"):
        printed, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(printed), redirect_stderr(errors):
            code = publish.main(["--release", str(self.release), "--out", str(self.dir / out), *map(str, extra)])
        return code, printed.getvalue(), errors.getvalue()

    def served_feed(self):
        return json.loads((self.bucket / "customgames.json").read_text())


class DryRunTests(Fixture):
    def test_a_dry_run_takes_the_next_sequence_from_the_live_feed_and_uploads_nothing(self):
        code, printed, errors = self.run_tool()
        self.assertEqual(0, code, errors)
        self.assertEqual(8, json.loads((self.dir / "out/customgames.json").read_text())["sequence"])
        self.assertEqual([], self.put_keys)
        self.assertEqual(7, self.served_feed()["sequence"])
        self.assertIn("Live feed: sequence 7, runtime v0, signature verified.", printed)
        self.assertIn("Dry run: nothing was uploaded.", printed)

    def test_a_dry_run_is_signed_with_a_throwaway_key_it_names(self):
        code, printed, _ = self.run_tool()
        throwaway = printed.rsplit("whose public half is ", 1)[1].strip().rstrip(".")
        self.assertNotEqual(self.public_key, throwaway)
        out = self.dir / "out/customgames.json"
        self.assertTrue(publish.signature_holds(throwaway, out.read_bytes(), (self.dir / "out/customgames.json.sig").read_bytes()))
        self.assertFalse(publish.signature_holds(self.public_key, out.read_bytes(), (self.dir / "out/customgames.json.sig").read_bytes()))

    def test_the_plan_puts_runtime_files_first_then_packages_and_art_and_the_feed_and_signature_last(self):
        _, printed, _ = self.run_tool()
        keys = [line.split(". ", 1)[1].split("  ")[0] for line in printed.splitlines() if line[:4].strip().rstrip(".").isdigit()]
        self.assertEqual(["runtime/v1/modlock-linux-amd64", "runtime/v1/modlock-windows-amd64.exe", "runtime/v1/modlock-host-windows-x64.zip"], keys[:3])
        self.assertEqual(["customgames.json", "customgames.json.sig"], keys[-2:])
        self.assertTrue(all(key.endswith(".zip") for key in keys[3:7]), keys)
        self.assertTrue(keys[7].startswith("art/"), keys)

    def test_the_platform_mod_and_renderer_come_from_the_releases_own_cli(self):
        self.assertEqual(0, self.run_tool()[0])
        feed = json.loads((self.dir / "out/customgames.json").read_text())
        renderer = self.dir / "out" / feed["runtime"]["renderer"]["url"].rsplit("/", 1)[1]
        with make_feed.zipfile.ZipFile(renderer) as archive:
            self.assertEqual(b"renderer of the release\n", archive.read("renderer.js"))
        platform = self.dir / "out" / feed["runtime"]["platform"]["url"].rsplit("/", 1)[1]
        with make_feed.zipfile.ZipFile(platform) as archive:
            self.assertEqual((publish.PLATFORM_MOD / "main.ts").read_bytes(), archive.read("mod.js"))
            self.assertEqual("hideout-platform", json.loads(archive.read("mod.json"))["slug"])

    def test_the_plan_says_what_differs_from_the_live_feed(self):
        _, printed, _ = self.run_tool()
        self.assertIn("runtime v1: was v0", printed)
        self.assertIn("arena 1.0.0: new", printed)

    def test_the_runtime_is_unchanged_only_when_its_files_are(self):
        live = {"runtime": {"modlock": "v1", "cli": {"linux": {"sha256": "a"}}, "host": {"sha256": "b"}, "platform": {}, "renderer": {}}}
        feed = {"runtime": {**live["runtime"], "host": {"sha256": "c"}}, "modes": []}
        self.assertEqual("runtime v1: its files changed under the same version", publish.describe(live, feed)[0])

    def test_a_live_feed_whose_signature_fails_stops_everything(self):
        other = self.dir / "other.pem"
        with redirect_stdout(io.StringIO()):
            make_feed.generate_test_key(other)
        make_feed.sign(other, self.bucket / "customgames.json")
        code, _, errors = self.run_tool()
        self.assertEqual(1, code)
        self.assertIn("does not verify with the key Hideout trusts", errors)
        self.assertFalse((self.dir / "out").exists())

    def test_no_live_feed_stops_everything(self):
        code, _, errors = self.run_tool("--feed-url", f"{self.base}/elsewhere.json")
        self.assertEqual(1, code)
        self.assertIn("cannot read", errors)

    def test_a_runtime_file_published_elsewhere_is_refused_by_its_url(self):
        release = json.loads(self.release.read_text())
        release["host"]["url"] = "https://github.com/paralin/modlock/releases/download/v1/modlock-host-windows-x64.zip"
        self.release.write_text(json.dumps(release))
        code, _, errors = self.run_tool()
        self.assertEqual(1, code)
        self.assertIn(f"published under {self.base}/runtime/, and https://github.com/paralin/modlock/releases/download/v1/modlock-host-windows-x64.zip is not", errors)

    def test_a_release_the_feed_tool_refuses_is_refused_with_its_reason(self):
        write(self.dir / "modes/arena/hideout.json", (LISTINGS / "invalid/players-over-64.json").read_text())
        code, _, errors = self.run_tool()
        self.assertEqual(1, code)
        self.assertIn("mode arena: hideout.json players must be", errors)
        self.assertIn("make_feed refused the release", errors)


class UploadTests(Fixture):
    def test_an_upload_puts_everything_in_order_and_reads_the_feed_back(self):
        code, printed, errors = self.run_tool("--key", self.key, "--upload")
        self.assertEqual(0, code, errors)
        self.assertEqual(["customgames.json", "customgames.json.sig"], self.put_keys[-2:])
        self.assertTrue(self.put_keys[0].startswith("runtime/v1/"))
        self.assertEqual(8, self.served_feed()["sequence"])
        self.assertIn("Live feed sequence 8 verified: its signature, 7 packages and 1 pictures.", printed)

    def test_a_second_publish_uploads_only_what_changed(self):
        self.assertEqual(0, self.run_tool("--key", self.key, "--upload")[0])
        self.put_keys.clear()
        write(self.dir / "modes/arena/mod.js", "// arena, faster\n")
        code, printed, errors = self.run_tool("--key", self.key, "--upload", out="again")
        self.assertEqual(0, code, errors)
        self.assertEqual(3, len(self.put_keys), self.put_keys)
        self.assertTrue(self.put_keys[0].startswith("rules-arena-1.0.0-"))
        self.assertIn("runtime v1: unchanged", printed)
        self.assertIn("arena 1.0.0: rules changed", printed)
        self.assertEqual(9, self.served_feed()["sequence"])

    def test_a_failed_upload_leaves_the_live_feed_alone(self):
        def failing(key, path):
            if key.endswith(".zip"):
                raise subprocess.CalledProcessError(1, ["wrangler", "r2", "object", "put", key])
            self.put(key, path)
        with patch.object(publish, "wrangler_put", failing):
            code, _, errors = self.run_tool("--key", self.key, "--upload")
        self.assertEqual(1, code)
        self.assertIn("nothing after it was uploaded", errors)
        self.assertEqual(7, self.served_feed()["sequence"])

    def test_a_published_file_is_never_replaced(self):
        self.assertEqual(0, self.run_tool("--key", self.key, "--upload")[0])
        write(self.bucket / "runtime/v1/modlock-host-windows-x64.zip", "another host bundle")
        code, _, errors = self.run_tool(out="again")
        self.assertEqual(1, code)
        self.assertIn("a published file is never replaced", errors)

    def test_a_runtime_rebuilt_under_its_published_version_is_refused_before_any_upload(self):
        self.assertEqual(0, self.run_tool("--key", self.key, "--upload")[0])
        self.put_keys.clear()
        write(self.dir / "runtime/modlock-windows-amd64.exe", "windows CLI")
        code, _, errors = self.run_tool("--key", self.key, "--upload", out="again")
        self.assertEqual(1, code)
        self.assertIn("runtime/v1/modlock-windows-amd64.exe already serves bytes with SHA-256", errors)
        self.assertEqual([], self.put_keys)

    def test_an_upload_needs_the_feed_key(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stopped:
            publish.parse_args(["--release", "r", "--out", "o", "--upload"])
        self.assertEqual(2, stopped.exception.code)

    def test_an_upload_follows_only_the_feed_and_key_the_app_trusts(self):
        for foreign in (["--feed-url", f"{self.base}/customgames.json"], ["--public-key", self.public_key], ["--allow-http"]):
            with patch.object(publish, "get") as reading, redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stopped:
                publish.main(["--release", str(self.release), "--out", str(self.dir / "out"), "--key", str(self.key), "--upload", *foreign])
            self.assertEqual(2, stopped.exception.code, foreign)
            reading.assert_not_called()
        self.assertEqual([], self.put_keys)
        self.assertFalse((self.dir / "out").exists())

    def test_a_key_other_than_the_trusted_one_uploads_nothing(self):
        other = self.dir / "other.pem"
        with redirect_stdout(io.StringIO()):
            make_feed.generate_test_key(other)
        code, _, errors = self.run_tool("--key", other, "--upload")
        self.assertEqual(1, code)
        self.assertIn("does not match --public-key", errors)
        self.assertEqual([], self.put_keys)


class VerifyTests(Fixture):
    def test_verify_checks_every_file_the_live_feed_names(self):
        self.assertEqual(0, self.run_tool("--key", self.key, "--upload")[0])
        code, printed, errors = self.run_tool("--verify")
        self.assertEqual(0, code, errors)
        self.assertIn("Live feed sequence 8 verified", printed)
        rules = next(self.bucket.glob("rules-arena-*.zip"))
        rules.write_bytes(rules.read_bytes()[:-1] + b"!")
        code, _, errors = self.run_tool("--verify")
        self.assertEqual(1, code)
        self.assertIn("arena rules:", errors)

    def test_a_picture_that_is_not_its_name_fails(self):
        self.assertEqual(0, self.run_tool("--key", self.key, "--upload")[0])
        write(next(self.bucket.glob("art/*")), "other pixels")
        code, _, errors = self.run_tool("--verify")
        self.assertEqual(1, code)
        self.assertIn("serves a picture whose digest", errors)

    def test_the_read_back_waits_for_the_edge_to_serve_the_new_feed(self):
        self.assertEqual(0, self.run_tool("--key", self.key, "--upload")[0])
        expected = (self.dir / "out/customgames.json").read_bytes()
        with self.assertRaisesRegex(publish.Problem, "still serves another feed"):
            publish.read_back(f"{self.base}/customgames.json", self.public_key, expected + b" ", b"sig", wait=0, pause=0)


class TrustedFeedTests(unittest.TestCase):
    def test_the_feed_key_is_an_ed25519_key_and_not_the_release_key(self):
        self.assertEqual(44, len(publish.base64.b64decode(publish.FEED_KEY)))
        self.assertNotEqual(make_feed.RELEASE_PUBLIC_KEY, publish.FEED_KEY)


if __name__ == "__main__":
    unittest.main()
