#!/usr/bin/env python3
import functools
import hashlib
import importlib.util
import io
import json
from contextlib import redirect_stdout
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("runtime_under_test", Path(__file__).with_name("runtime.py"))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.site = self.root / "site"
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(self.site)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.host_zip = io.BytesIO()
        with zipfile.ZipFile(self.host_zip, "w") as archive:
            archive.writestr("modlock-host.exe", "host")
            archive.writestr("quickjs.wasm", "interpreter")
        self.files = {runtime.LINUX_CLI: b"#!/bin/sh\n", runtime.WINDOWS_CLI: b"windows", runtime.HOST_ZIP: self.host_zip.getvalue()}
        self.pin = {"upstream": "https://example.test/modlock.git", "revision": "a" * 40, "version": "aaaaaaa-hideout.1",
                    "files": {name: digest(data) for name, data in self.files.items()}, "toolchains": []}
        (self.root / "runtime.json").write_text(json.dumps(self.pin))
        for name, value in (("REPO", self.root), ("LOCAL", self.root / ".local/runtime"), ("SOURCE", self.root / ".tools/modlock"),
                            ("PIN", self.pin), ("PIN_PATH", self.root / "runtime.json"),
                            ("RELEASES", f"http://127.0.0.1:{server.server_address[1]}/runtime")):
            patcher = patch.object(runtime, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def publish_files(self):
        for name, data in self.files.items():
            path = self.site / "runtime" / self.pin["version"] / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def quietly(self, action, *args):
        with redirect_stdout(io.StringIO()):
            return action(*args)

    def test_install_fetches_the_pinned_files_and_unpacks_the_host_beside_the_cli(self):
        self.publish_files()
        self.quietly(runtime.install_runtime)
        runtime.require()
        self.assertEqual(b"#!/bin/sh\n", runtime.cli().read_bytes())
        self.assertTrue(runtime.cli().stat().st_mode & 0o100)
        self.assertEqual("host", runtime.host().read_text())
        self.assertEqual("interpreter", (runtime.host().parent / "quickjs.wasm").read_text())

    def test_a_download_that_is_not_the_recorded_file_is_refused_and_left_nowhere(self):
        self.publish_files()
        (self.site / "runtime" / self.pin["version"] / runtime.WINDOWS_CLI).write_bytes(b"another build")
        with self.assertRaisesRegex(RuntimeError, "is not the file runtime.json records"):
            self.quietly(runtime.runtime_files)
        self.assertEqual([], list(runtime.files_dir().glob(f"{runtime.WINDOWS_CLI}*")))

    def test_a_runtime_the_site_lacks_says_to_build_it(self):
        with self.assertRaisesRegex(RuntimeError, "answered 404.*build it with python3 scripts/runtime.py build"):
            self.quietly(runtime.runtime_files)

    def test_a_pin_without_digests_says_to_build_it(self):
        self.pin["files"] = {}
        with self.assertRaisesRegex(RuntimeError, "records no digest.*python3 scripts/runtime.py build"):
            runtime.runtime_files()

    def test_files_already_here_are_not_fetched_again(self):
        runtime.files_dir().mkdir(parents=True)
        for name, data in self.files.items():
            (runtime.files_dir() / name).write_bytes(data)
        self.assertEqual(self.pin["files"], runtime.runtime_files())

    def test_a_new_pin_needs_a_new_install(self):
        self.publish_files()
        self.quietly(runtime.install_runtime)
        self.pin["files"] = {**self.pin["files"], runtime.HOST_ZIP: "0" * 64}
        with self.assertRaisesRegex(RuntimeError, "is not installed"):
            runtime.require()

    def test_every_mode_reads_the_one_checkout(self):
        for mode in ("one", "two"):
            (self.root / "mods" / mode / "gameplay").mkdir(parents=True)
        (self.root / "mods/notes").mkdir()
        runtime.SOURCE.mkdir(parents=True)
        runtime.link_modes()
        runtime.link_modes()
        for mode in ("one", "two"):
            link = self.root / "mods" / mode / ".tools/modlock"
            self.assertTrue(link.is_symlink())
            self.assertEqual(runtime.SOURCE.resolve(), link.resolve())
            self.assertEqual("../../../.tools/modlock", str(link.readlink()))
        self.assertFalse((self.root / "mods/notes/.tools").exists())

    def test_a_modes_own_checkout_is_never_removed(self):
        (self.root / "mods/one/gameplay").mkdir(parents=True)
        (self.root / "mods/one/.tools/modlock/js").mkdir(parents=True)
        with self.assertRaisesRegex(RuntimeError, "is a Modlock checkout of its own"):
            runtime.link_modes()
        self.assertTrue((self.root / "mods/one/.tools/modlock/js").is_dir())

    def hideout(self) -> Path:
        checkout = self.root / "hideout"
        (checkout / "tools/link").mkdir(parents=True)
        (checkout / "tools/link/pin_modlock.py").write_text(
            "import pathlib, sys\npathlib.Path(__file__).with_name('pinned').write_text(sys.argv[1])\n")
        return checkout

    def test_a_pin_to_a_commit_names_its_version_waits_for_a_build_and_moves_hideouts_helper(self):
        checkout = self.hideout()
        with patch.dict(runtime.os.environ, {"HIDEOUT_REPO": str(checkout)}):
            self.quietly(runtime.pin_revision, "b" * 40)
        written = json.loads((self.root / "runtime.json").read_text())
        self.assertEqual(("b" * 40, "bbbbbbb-hideout.1", {}), (written["revision"], written["version"], written["files"]))
        self.assertEqual("b" * 40, (checkout / "tools/link/pinned").read_text())

    def test_a_pin_without_hideout_changes_nothing(self):
        with patch.dict(runtime.os.environ, {"HIDEOUT_REPO": str(self.root / "elsewhere")}):
            with self.assertRaisesRegex(RuntimeError, "Set HIDEOUT_REPO"):
                runtime.pin_revision("b" * 40)
        self.assertEqual("a" * 40, json.loads((self.root / "runtime.json").read_text())["revision"])

    def test_the_host_zip_is_the_same_bytes_from_the_same_files(self):
        folder = self.root / "bin"
        (folder / "sub").mkdir(parents=True)
        (folder / "b.dll").write_text("b")
        (folder / "sub/a.wasm").write_text("a")
        runtime.write_zip(folder, self.root / "one.zip")
        time.sleep(0.01)
        (folder / "b.dll").write_text("b")
        runtime.write_zip(folder, self.root / "two.zip")
        self.assertEqual((self.root / "one.zip").read_bytes(), (self.root / "two.zip").read_bytes())
        with zipfile.ZipFile(self.root / "one.zip") as archive:
            self.assertEqual(["b.dll", "sub/a.wasm"], archive.namelist())

    def test_a_watched_session_stages_the_authored_ui_when_it_changes(self):
        authored = self.root / "panorama"
        authored.mkdir()
        (authored / "hud.xml").write_text("<root/>")
        staged = []

        def edit():
            time.sleep(0.8)
            (authored / "hud.xml").write_text("<root class='new'/>")

        threading.Thread(target=edit).start()
        session = [sys.executable, "-c", "import time; time.sleep(2.5)"]
        code = self.quietly(runtime.run_following, session, [authored, self.root / "absent"], lambda: staged.append(True))
        self.assertEqual(0, code)
        self.assertEqual([True], staged)


if __name__ == "__main__":
    unittest.main()
