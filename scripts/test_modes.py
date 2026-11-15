#!/usr/bin/env python3
import argparse
import importlib.util
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("modes_under_test", Path(__file__).with_name("modes.py"))
modes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(modes)
LISTING = {"name": "Arena", "tagline": "Fight.", "description": "Fight on a roof.", "players": {"min": 2, "max": 8},
           "creators": ["Hideout team"], "released": "2026-11-01", "art": {"card": "art/card.png"}}


def write(path: Path, value) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value))
    return path


class Fixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, value in (("REPO", self.root), ("MODS", self.root / "mods"), ("RELEASE", self.root / "release.json"),
                            ("UPCOMING", self.root / "upcoming"), ("WORK", self.root / ".local/publish")):
            patcher = patch.object(modes, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.pin = {"revision": "130ef5a425cc9f3198a9528be8789b78822f4a1c", "version": "130ef5a-hideout.1",
                    "files": {name: "0" * 64 for name in modes.runtime.FILES}}
        for name, value in (("PIN", self.pin), ("PIN_PATH", write(self.root / "runtime.json", self.pin))):
            patcher = patch.object(modes.runtime, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        write(self.root / "release.json", {"modes": ["arena"], "upcoming": ["dodgeball"]})
        self.project = self.root / "mods/arena/gameplay"
        write(self.project / "mod.json", {"slug": "arena", "version": "0.1.0"})
        write(self.project / "hideout.json", LISTING)
        write(self.project / "art/card.png", "card")
        write(self.root / "upcoming/dodgeball.json", {key: LISTING[key] for key in ("name", "tagline", "description", "players", "creators")})
        self.hideout = self.root / "hideout"
        write(self.hideout / "tools/link/go.mod", "module hideout/tools/link\n\nreplace github.com/paralin/modlock => "
                                                  "github.com/hideouthq/modlock v0.1.74-0.20261112111808-130ef5a425cc\n")


class ReleaseTests(Fixture):
    def test_a_release_hideout_would_take_has_no_problems(self):
        self.assertEqual([], modes.release_problems())

    def test_a_mode_whose_slug_is_not_its_id_is_named(self):
        write(self.project / "mod.json", {"slug": "new-deadlock-game", "version": "0.1.0"})
        self.assertEqual(["arena: mod.json's slug is 'new-deadlock-game', and a feed id must be its mode's slug"], modes.release_problems())

    def test_a_listing_is_held_to_hideouts_rules(self):
        write(self.project / "hideout.json", {**LISTING, "players": {"min": 2, "max": 65}})
        self.assertEqual(["arena: hideout.json players must be a min and a max with 1 <= min <= max <= 64"], modes.release_problems())

    def test_art_the_listing_names_must_be_beside_it(self):
        (self.project / "art/card.png").unlink()
        self.assertIn("card.png is missing", " ".join(modes.release_problems()))

    def test_an_upcoming_listing_may_leave_out_its_date_but_nothing_else(self):
        write(self.root / "upcoming/dodgeball.json", {"name": "Dodgeball"})
        self.assertIn("upcoming dodgeball: dodgeball.json tagline must be", " ".join(modes.release_problems()))

    def test_ids_are_unique_and_every_upcoming_file_is_released(self):
        write(self.root / "release.json", {"modes": ["arena"], "upcoming": ["arena"]})
        write(self.root / "upcoming/arena.json", LISTING)
        problems = modes.release_problems()
        self.assertIn("release.json names arena twice", problems)
        self.assertIn("upcoming/dodgeball.json is not in release.json", problems)

    def test_a_mode_with_no_manifest_is_named(self):
        write(self.root / "release.json", {"modes": ["arena", "pillars"], "upcoming": ["dodgeball"]})
        self.assertEqual(["pillars: release.json names it, but there is no mods/pillars/gameplay/mod.json"], modes.release_problems())


class PinTests(Fixture):
    def test_a_built_pin_has_no_problems(self):
        self.assertEqual([], modes.pin_problems())

    def test_a_pin_that_was_never_built_cannot_be_published(self):
        self.pin["files"] = {}
        self.assertEqual(3, len([p for p in modes.pin_problems() if "python3 scripts/runtime.py build" in p]))

    def test_the_helper_and_the_runtime_agree(self):
        self.assertEqual([], modes.helper_problems(self.hideout))

    def test_a_helper_on_another_commit_names_the_checkout_read_and_how_to_move_it(self):
        self.pin["revision"] = "b" * 40
        self.pin["version"] = "bbbbbbb-hideout.1"
        self.assertEqual([f"Hideout's helper at {self.hideout} imports Modlock v0.1.74-0.20261112111808-130ef5a425cc, but "
                          f"runtime.json pins {'b' * 12}. Set HIDEOUT_REPO to the checkout you release from, or move it with "
                          f"python3 scripts/runtime.py pin {'b' * 40}"], modes.helper_problems(self.hideout))


class BuildFolderTests(Fixture):
    def test_the_build_folder_carries_the_listing_and_only_its_current_art(self):
        write(self.project / "build/art/old.png", "old")
        build = modes.listing_into_build("arena")
        self.assertEqual(LISTING, json.loads((build / "hideout.json").read_text()))
        self.assertEqual(["card.png"], sorted(path.name for path in (build / "art").iterdir()))


class PublishTests(Fixture):
    def setUp(self):
        super().setUp()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture"], check=True)
        write(self.hideout / "tools/link/pin_modlock.py", "")
        for patched in (patch.object(modes.runtime, "runtime_files", lambda: self.pin["files"]),
                        patch.dict(modes.os.environ, {"HIDEOUT_REPO": str(self.hideout)})):
            patched.start()
            self.addCleanup(patched.stop)

    def arguments(self, *given):
        return argparse.Namespace(mode=list(given), key=None, upload=False, verify=False)

    def test_a_runtime_hideouts_helper_does_not_share_is_refused_before_anything_builds(self):
        self.pin["revision"] = "b" * 40
        with patch.object(modes, "build") as building, self.assertRaisesRegex(RuntimeError, "Hideout's helper at .* imports Modlock"):
            modes.publish(self.arguments())
        building.assert_not_called()

    def test_uncommitted_mode_sources_are_refused_before_anything_builds(self):
        write(self.project / "main.ts", "changed")
        with patch.object(modes, "build") as building, self.assertRaisesRegex(RuntimeError, "Commit these first"):
            modes.publish(self.arguments())
        building.assert_not_called()

    def test_what_a_mode_lacks_is_said_before_anything_builds(self):
        with patch.object(modes, "ready", return_value=["No verified map build."]), patch.object(modes, "build") as building, \
                self.assertRaisesRegex(RuntimeError, "arena: No verified map build.\nProvide what is missing.*--mode <id>="):
            modes.publish(self.arguments())
        building.assert_not_called()

    def publish_built_elsewhere(self, folder):
        real, published, printed = subprocess.run, [], io.StringIO()

        def running(command, *args, **kwargs):
            if str(command[1]).endswith("publish.py"):
                published.append(command)
                return subprocess.CompletedProcess(command, 0)
            return real(command, *args, **kwargs)

        with patch.object(modes, "ready") as asking, patch.object(modes.subprocess, "run", running), redirect_stdout(printed):
            self.assertEqual(0, modes.publish(self.arguments(f"arena={folder}")))
        asking.assert_not_called()
        return published, printed.getvalue()

    def test_a_publish_with_no_hideout_checkout_says_the_helper_went_unchecked(self):
        with patch.dict(modes.os.environ, {"HIDEOUT_REPO": str(self.root / "elsewhere")}):
            published, printed = self.publish_built_elsewhere(self.root / "built")
        self.assertEqual([str(modes.FEED / "publish.py")], [command[1] for command in published])
        self.assertIn("No Hideout checkout at HIDEOUT_REPO or ../hideout", printed)

    def test_a_mode_built_elsewhere_is_taken_as_it_is(self):
        folder = self.root / "elsewhere"
        published, _ = self.publish_built_elsewhere(folder)
        release = json.loads((self.root / ".local/publish/release.json").read_text())
        self.assertEqual([{"id": "arena", "dir": str(folder)}], release["modes"])
        self.assertEqual(f"{modes.runtime.RELEASES}/130ef5a-hideout.1/modlock-linux-amd64", release["cli"]["linux"]["url"])
        self.assertEqual("0" * 64, release["host"]["sha256"])
        self.assertEqual([{"id": "dodgeball", "listing": str(self.root / "upcoming/dodgeball.json")}], release["upcoming"])
        self.assertEqual(["--release", str(self.root / ".local/publish/release.json"), "--out", str(self.root / ".local/publish/out")],
                         published[0][2:])

    def test_a_mode_the_release_does_not_name_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "give a mode release.json names"):
            modes.publish(self.arguments("pillars=/tmp/x"))

    def test_only_dev_and_play_pass_flags_to_the_mode(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            modes.main(["test", "arena", "--bots", "3"])


if __name__ == "__main__":
    unittest.main()
