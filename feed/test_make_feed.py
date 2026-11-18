#!/usr/bin/env python3
import base64
import hashlib
import importlib.util
import io
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stderr
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
MAKE_FEED = HERE / "make_feed.py"
GOLDEN = HERE / "testdata" / "customgames.json"
LISTINGS = HERE / "testdata" / "listings"
SIGN_FEED = HERE / "sign_feed.sh"
BASE = "https://feed.example/packages"
RELEASES = "https://github.com/paralin/modlock/releases/download/v0.1.72"

spec = importlib.util.spec_from_file_location("make_feed", MAKE_FEED)
make_feed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make_feed)


def write(path, text="x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def built_mod(folder, slug, version="1.0.0", **manifest):
    write(folder / "mod.json", json.dumps({"slug": slug, "name": slug, "version": version, "entry": "mod.js", **manifest}))
    write(folder / "mod.js", f"// {slug}\n")
    write(folder / "mod.js.map", "{}")
    write(folder / ".build.lock", "")
    write(folder / "session.log", "a log")
    return folder


class Fixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        self.key = self.dir / "throwaway.pem"
        self.public_key = self.run_tool("--generate-test-key", self.key).stdout.strip()
        self.out = self.dir / "out"
        write(self.dir / "files/modlock-linux-amd64", "linux cli")
        write(self.dir / "files/modlock-windows-amd64.exe", "windows cli")
        write(self.dir / "files/modlock-host-windows-x64.zip", "host bundle")
        built_mod(self.dir / "platform", "hideout-platform", "2.0.0")
        write(self.dir / "renderer/renderer.js", "renderer")
        write(self.dir / "renderer/layout.js", "layout")
        plain = built_mod(self.dir / "plain", "plain-mode")
        write(plain / "hideout.json", (LISTINGS / "valid/minimal.json").read_text())
        rich = built_mod(self.dir / "rich", "rich-mode", map="arena")
        write(rich / "hideout.json", (LISTINGS / "valid/bebop-wars.json").read_text())
        for path in make_feed.art_paths(json.loads((LISTINGS / "valid/bebop-wars.json").read_text())["art"]):
            write(rich / path, f"{PurePosixPath(path).stem} pixels")
        for case in sorted((LISTINGS / "upcoming").glob("*.json")):
            write(self.dir / "upcoming" / case.name, case.read_text())
        write(rich / "maps/arena.vpk", "map")
        write(rich / "maps/unrelated.vpk", "not named by the manifest")
        write(rich / "panorama/layout/rich-mode/panel.vxml_c", "panel")
        write(rich / "data/areas.yaml", "areas")
        self.source = {
            "modlock": "v0.1.72",
            "cli": {
                "linux": {"url": f"{RELEASES}/modlock-linux-amd64", "file": "files/modlock-linux-amd64"},
                "windows": {"url": f"{RELEASES}/modlock-windows-amd64.exe", "file": "files/modlock-windows-amd64.exe"},
            },
            "host": {"url": f"{RELEASES}/modlock-host-windows-x64.zip", "file": "files/modlock-host-windows-x64.zip"},
            "platform": "platform",
            "renderer": "renderer",
            "modes": [
                {"id": "plain-mode", "dir": "plain"},
                {"id": "rich-mode", "dir": "rich"},
            ],
            "upcoming": [
                {"id": "heaven-or-else", "listing": "upcoming/heaven-or-else.json"},
                {"id": "dodgeball", "listing": "upcoming/dodgeball.json"},
                {"id": "hero-roulette", "listing": "upcoming/hero-roulette.json"},
            ],
        }

    def run_tool(self, *arguments):
        return subprocess.run([sys.executable, MAKE_FEED, *map(str, arguments)], capture_output=True, text=True)

    def publish(self, *extra, sequence=7, out=None, key=None, public_key=None, base=BASE):
        path = self.dir / "source.json"
        path.write_text(json.dumps(self.source))
        return self.run_tool("--source", path, "--sequence", sequence, "--key", key or self.key, "--public-key", public_key or self.public_key,
                             "--base-url", base, "--out", out or self.out, *extra)

    def published(self, *extra, **kwargs):
        result = self.publish(*extra, **kwargs)
        self.assertEqual(0, result.returncode, result.stderr)
        return json.loads(((kwargs.get("out") or self.out) / "customgames.json").read_text())

    def assert_refused(self, result, message):
        self.assertEqual(1, result.returncode, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()), "a refused feed writes nothing")

    def zip_names(self, artifact):
        with zipfile.ZipFile(self.out / artifact["url"].rsplit("/", 1)[1]) as archive:
            return archive.namelist()


class FeedTests(Fixture):
    def test_the_feed_names_every_package_by_its_url_size_and_digest(self):
        feed = self.published()
        self.assertEqual((2, 7, "v0.1.72"), (feed["schema"], feed["sequence"], feed["runtime"]["modlock"]))
        self.assertEqual(f"{RELEASES}/modlock-linux-amd64", feed["runtime"]["cli"]["linux"]["url"])
        self.assertEqual(hashlib.sha256(b"linux cli").hexdigest(), feed["runtime"]["cli"]["linux"]["sha256"])
        self.assertEqual(len("host bundle"), feed["runtime"]["host"]["bytes"])
        rules = feed["modes"][0]["rules"]
        served = self.out / rules["url"].removeprefix(f"{BASE}/")
        self.assertEqual(hashlib.sha256(served.read_bytes()).hexdigest(), rules["sha256"])
        self.assertEqual(served.stat().st_size, rules["bytes"])
        self.assertEqual("1.0.0", feed["modes"][1]["version"])

    def test_a_package_holds_what_modlock_ships_and_no_logs_or_source_maps(self):
        feed = self.published()
        self.assertEqual(["mod.js", "mod.json"], self.zip_names(feed["runtime"]["platform"]))
        self.assertEqual(["mod.js", "mod.json"], self.zip_names(feed["modes"][0]["rules"]))
        self.assertEqual(["layout.js", "renderer.js"], self.zip_names(feed["runtime"]["renderer"]))

    def test_rules_hold_no_content_so_modlock_does_not_mount_over_the_renderer(self):
        feed = self.published()
        self.assertEqual(["data/areas.yaml", "mod.js", "mod.json"], self.zip_names(feed["modes"][1]["rules"]))

    def test_only_a_mode_with_client_content_names_a_client_package(self):
        feed = self.published()
        self.assertNotIn("client", feed["modes"][0])
        self.assertEqual(["maps/arena.vpk", "panorama/layout/rich-mode/panel.vxml_c"], self.zip_names(feed["modes"][1]["client"]))

    def test_notices_travel_with_every_existing_package(self):
        for mode in ("plain", "rich"):
            write(self.dir / mode / "LICENSE", "Creator's notice")
        plain, rich = self.published()["modes"]
        self.assertNotIn("client", plain)
        for artifact in (plain["rules"], rich["rules"], rich["client"]):
            with zipfile.ZipFile(self.out / artifact["url"].rsplit("/", 1)[1]) as package:
                self.assertEqual(b"Creator's notice", package.read("LICENSE"))

    def test_a_feed_needs_a_whole_renderer(self):
        (self.dir / "renderer/layout.js").unlink()
        self.assert_refused(self.publish(), "layout.js is missing")
        del self.source["renderer"]
        self.assert_refused(self.publish(), "needs a renderer folder")

    def test_the_same_build_makes_the_same_bytes_whatever_its_clock(self):
        first = self.published()
        for path in (self.dir / "rich").rglob("*"):
            if path.is_file():
                os.utime(path, (1_000_000_000, 1_000_000_000))
                path.chmod(0o600)
        second = self.published(out=self.dir / "again")
        self.assertEqual(first, second)
        self.assertEqual((self.out / "customgames.json").read_bytes(), (self.dir / "again/customgames.json").read_bytes())
        with zipfile.ZipFile(self.out / first["modes"][1]["rules"]["url"].rsplit("/", 1)[1]) as archive:
            for info in archive.infolist():
                self.assertEqual((1980, 1, 1, 0, 0, 0), info.date_time)
                self.assertEqual(0o644, stat.S_IMODE(info.external_attr >> 16))

    def test_a_changed_build_gets_a_new_url(self):
        first = self.published()
        write(self.dir / "plain/mod.js", "// changed\n")
        second = self.published(out=self.dir / "again")
        self.assertNotEqual(first["modes"][0]["rules"]["url"], second["modes"][0]["rules"]["url"])

    def test_a_symbolic_link_in_a_package_is_refused(self):
        write(self.dir / "secret", "secret")
        (self.dir / "rich/data/secret").symlink_to(self.dir / "secret")
        self.assert_refused(self.publish(), "is a symbolic link")

    def test_a_folder_that_links_elsewhere_is_refused(self):
        (self.dir / "plain/data").symlink_to(self.dir)
        self.assert_refused(self.publish(), "is a symbolic link")

    def test_an_entry_outside_the_build_folder_is_refused(self):
        built_mod(self.dir / "plain", "plain-mode", entry="../secret.js")
        self.assert_refused(self.publish(), "is not a path inside the folder")

    def test_a_build_without_its_entry_is_refused(self):
        (self.dir / "plain/mod.js").unlink()
        self.assert_refused(self.publish(), "is missing or is not a file")

    def test_the_out_folder_must_be_empty(self):
        write(self.out / "left-over")
        result = self.publish()
        self.assertEqual(1, result.returncode)
        self.assertIn("must be an empty or new folder", result.stderr)


class ListingTests(Fixture):
    def test_every_shared_valid_listing_passes(self):
        for case in sorted((LISTINGS / "valid").glob("*.json")):
            self.assertEqual([], make_feed.listing_problems(json.loads(case.read_text())), case.name)

    def test_every_shared_invalid_listing_is_refused(self):
        cases = sorted((LISTINGS / "invalid").glob("*.json"))
        self.assertGreaterEqual(len(cases), 20)
        for case in cases:
            self.assertNotEqual([], make_feed.listing_problems(json.loads(case.read_text())), case.name)

    def test_an_upcoming_listing_may_leave_out_only_its_release_date(self):
        cases = sorted((LISTINGS / "upcoming").glob("*.json"))
        self.assertEqual(3, len(cases))
        for case in cases:
            listing = json.loads(case.read_text())
            self.assertEqual([], make_feed.listing_problems(listing, upcoming=True), case.name)
            self.assertEqual(["released must be a date, YYYY-MM-DD"], make_feed.listing_problems(listing), case.name)
        for case in sorted((LISTINGS / "invalid").glob("*.json")):
            if case.name != "no-released.json":
                self.assertNotEqual([], make_feed.listing_problems(json.loads(case.read_text()), upcoming=True), case.name)

    def test_the_listing_is_the_build_folders_own_with_art_served_beside_the_packages(self):
        feed = self.published()
        self.assertEqual(json.loads((LISTINGS / "valid/minimal.json").read_text()), feed["modes"][0]["listing"])
        listing = feed["modes"][1]["listing"]
        self.assertEqual(("Bebop Wars", {"min": 2, "max": 6}), (listing["name"], listing["players"]))
        card = listing["art"]["card"]
        self.assertRegex(card, rf"^{BASE}/art/[0-9a-f]{{12}}-card-background%402x\.jpg$")
        self.assertEqual("card-background@2x pixels", (self.out / unquote(card.removeprefix(f"{BASE}/"))).read_text())
        self.assertEqual(3, len(listing["art"]["screenshots"]))
        self.assertTrue(all(url.startswith(f"{BASE}/art/") for url in [*listing["art"]["screenshots"], listing["art"]["explainer"], listing["art"]["overlay"]]))

    def test_upcoming_modes_are_listings_with_no_version_or_package(self):
        feed = self.published()
        self.assertEqual(["heaven-or-else", "dodgeball", "hero-roulette"], [entry["id"] for entry in feed["upcoming"]])
        for entry in feed["upcoming"]:
            self.assertEqual({"id", "listing"}, set(entry))
        self.assertEqual(json.loads((LISTINGS / "upcoming/dodgeball.json").read_text()), feed["upcoming"][1]["listing"])
        self.assertEqual(["plain-mode", "rich-mode"], [mode["id"] for mode in feed["modes"]])

    def test_an_upcoming_listings_art_is_served_like_a_modes(self):
        listing = json.loads((self.dir / "upcoming/dodgeball.json").read_text())
        write(self.dir / "upcoming/art/card.png", "dodgeball card")
        write(self.dir / "upcoming/dodgeball.json", json.dumps({**listing, "art": {"card": "art/card.png"}}))
        card = self.published()["upcoming"][1]["listing"]["art"]["card"]
        self.assertEqual("dodgeball card", (self.out / card.removeprefix(f"{BASE}/")).read_text())

    def test_an_upcoming_listing_that_breaks_a_rule_is_refused_with_it(self):
        write(self.dir / "upcoming/dodgeball.json", (LISTINGS / "invalid/players-over-64.json").read_text())
        self.assert_refused(self.publish(), "upcoming dodgeball: dodgeball.json players must be a min and a max")

    def test_an_upcoming_mode_cannot_share_an_id_with_a_mode(self):
        self.source["upcoming"][0]["id"] = "rich-mode"
        self.assert_refused(self.publish(), "mode rich-mode: listed twice")

    def test_an_upcoming_listings_art_must_be_beside_it(self):
        listing = json.loads((self.dir / "upcoming/dodgeball.json").read_text())
        write(self.dir / "upcoming/dodgeball.json", json.dumps({**listing, "art": {"card": "art/missing.png"}}))
        self.assert_refused(self.publish(), "missing.png is missing")

    def test_the_listing_and_art_stay_out_of_the_packages(self):
        feed = self.published()
        names = self.zip_names(feed["modes"][1]["rules"]) + self.zip_names(feed["modes"][1]["client"])
        self.assertFalse([name for name in names if name == "hideout.json" or name.startswith("art/")], names)

    def test_players_that_only_look_like_numbers_are_refused(self):
        listing = json.loads((LISTINGS / "valid/minimal.json").read_text())
        for players in ({"min": 1}, {"min": True, "max": 2}, {"min": 1.0, "max": 2}, {"min": "1", "max": 2}):
            self.assertEqual(["players must be a min and a max with 1 <= min <= max <= 64"], make_feed.listing_problems({**listing, "players": players}))

    def test_a_broken_listing_is_refused_with_its_rule(self):
        write(self.dir / "plain/hideout.json", (LISTINGS / "invalid/players-over-64.json").read_text())
        self.assert_refused(self.publish(), "mode plain-mode: hideout.json players must be a min and a max")

    def test_a_build_without_a_listing_is_refused(self):
        (self.dir / "plain/hideout.json").unlink()
        self.assert_refused(self.publish(), "hideout.json")

    def test_art_must_be_a_file_in_the_build_folder(self):
        (self.dir / "rich/art/bebop-thumb@2x.png").unlink()
        self.assert_refused(self.publish(), "bebop-thumb@2x.png is missing")
        write(self.dir / "secret.png", "secret")
        (self.dir / "rich/art/bebop-thumb@2x.png").symlink_to(self.dir / "secret.png")
        self.assert_refused(self.publish(), "bebop-thumb@2x.png is missing, or is not a file in the build folder")

    def test_art_outside_the_build_folder_is_refused(self):
        listing = json.loads((self.dir / "rich/hideout.json").read_text())
        listing["art"]["card"] = "../secret.png"
        write(self.dir / "rich/hideout.json", json.dumps(listing))
        self.assert_refused(self.publish(), "each a path inside the build folder")


class SourceTests(Fixture):
    def refused(self, message, change):
        change(self.source)
        self.assert_refused(self.publish(), message)

    def test_a_wrong_digest_for_a_modlock_file_is_refused(self):
        self.refused("instead of " + "0" * 64, lambda s: s["host"].update(sha256="0" * 64))

    def test_a_matching_digest_passes(self):
        self.source["host"]["sha256"] = hashlib.sha256(b"host bundle").hexdigest()
        self.published()

    def test_modlock_urls_must_be_https_and_of_the_pinned_version(self):
        self.refused("is not https", lambda s: s["host"].update(url="http://github.com/x/v0.1.72/modlock-host-windows-x64.zip"))
        self.source["host"]["url"] = f"{RELEASES}/modlock-host-windows-x64.zip"
        self.refused("is not under Modlock v0.1.73", lambda s: s.update(modlock="v0.1.73"))

    def test_a_url_and_file_that_differ_are_refused(self):
        self.refused("but the file is modlock-linux-amd64", lambda s: s["cli"]["linux"].update(url=f"{RELEASES}/modlock-darwin-amd64"))

    def test_an_unknown_operating_system_is_refused_rather_than_ignored_by_the_app(self):
        self.refused("cli: darwin is not one of", lambda s: s["cli"].update(darwin=s["cli"]["linux"]))

    def test_a_feed_needs_a_cli(self):
        self.refused("cli must name at least one", lambda s: s.update(cli={}))

    def test_one_cli_is_enough(self):
        del self.source["cli"]["windows"]
        self.assertEqual(["linux"], list(self.published()["runtime"]["cli"]))

    def test_the_apps_limits_on_a_mode_are_refused_here_first(self):
        self.refused("id 'Bad Id'", lambda s: s["modes"][0].update(id="Bad Id"))
        self.source["modes"][0]["id"] = "plain-mode"
        self.refused("unknown field name", lambda s: s["modes"][0].update(name="Plain"))

    def test_a_mode_listed_twice_is_refused(self):
        self.refused("mode plain-mode: listed twice", lambda s: s["modes"].append(s["modes"][0]))

    def test_a_build_that_is_not_the_named_mode_is_refused(self):
        self.refused("its build's slug is plain-mode", lambda s: s["modes"][0].update(id="other"))

    def test_a_version_that_cannot_name_a_file_is_refused(self):
        built_mod(self.dir / "plain", "plain-mode", version="1.0 beta")
        self.assert_refused(self.publish(), "version '1.0 beta' names files")

    def test_an_unknown_source_field_is_refused(self):
        self.refused("unknown field relay", lambda s: s.update(relay={}))


class SequenceTests(Fixture):
    def previous(self, sequence):
        return write(self.dir / "previous.json", json.dumps({"sequence": sequence}))

    def test_the_sequence_is_required(self):
        result = self.run_tool("--source", "s", "--key", "k", "--public-key", "p", "--base-url", BASE, "--out", self.out)
        self.assertEqual(2, result.returncode)
        self.assertIn("--sequence required", result.stderr)

    def test_a_sequence_at_or_below_the_previous_feeds_is_refused(self):
        for sequence in (7, 6):
            self.assert_refused(self.publish("--previous", self.previous(7), sequence=sequence), "is not higher than 7")

    def test_a_higher_sequence_passes(self):
        self.assertEqual(8, self.published("--previous", self.previous(7), sequence=8)["sequence"])

    def test_an_unreadable_previous_feed_is_refused(self):
        self.assert_refused(self.publish("--previous", self.dir / "none.json"), "cannot read")
        self.assert_refused(self.publish("--previous", write(self.dir / "broken.json", "{}")), "has no sequence")

    def test_a_sequence_below_one_is_refused(self):
        self.assert_refused(self.publish(sequence=0), "must be positive")


class BaseUrlTests(Fixture):
    def test_http_needs_the_local_test_flag(self):
        self.assert_refused(self.publish(base="http://127.0.0.1:8000"), "must be https")
        rules = self.published("--allow-http", base="http://127.0.0.1:8000/")["modes"][0]["rules"]
        self.assertTrue(rules["url"].startswith("http://127.0.0.1:8000/rules-plain-mode-1.0.0-"), rules["url"])

    def test_a_local_test_feed_may_name_runtime_files_it_serves_over_http(self):
        host = "http://127.0.0.1:8000/runtime/v0.1.72/modlock-host-windows-x64.zip"
        self.source["host"]["url"] = host
        self.assert_refused(self.publish(base="http://127.0.0.1:8000"), f"host: {host} is not https")
        self.assertEqual(host, self.published("--allow-http", base="http://127.0.0.1:8000")["runtime"]["host"]["url"])


class SigningTests(Fixture):
    def verify(self, public_key, feed, signature):
        work = self.dir / "verify"
        work.mkdir(exist_ok=True)
        der = write(work / "public.der", "")
        der.write_bytes(base64.b64decode(public_key))
        raw = write(work / "raw", "")
        raw.write_bytes(base64.b64decode(signature.read_bytes()))
        return subprocess.run(["openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-keyform", "DER", "-inkey", der, "-sigfile", raw, "-in", feed],
                              capture_output=True).returncode

    def test_the_signature_verifies_over_the_feeds_exact_bytes(self):
        self.published()
        feed, signature = self.out / "customgames.json", self.out / "customgames.json.sig"
        self.assertEqual(0, self.verify(self.public_key, feed, signature))
        write(feed, feed.read_text() + " ")
        self.assertNotEqual(0, self.verify(self.public_key, feed, signature))

    def test_the_signature_is_base64_of_64_raw_bytes_on_one_line(self):
        self.published()
        text = (self.out / "customgames.json.sig").read_bytes()
        self.assertEqual(88, len(text))
        self.assertEqual(64, len(base64.b64decode(text, validate=True)))

    def test_a_key_other_than_the_trusted_one_is_refused(self):
        other = self.dir / "other.pem"
        other_public = self.run_tool("--generate-test-key", other).stdout.strip()
        self.assert_refused(self.publish(key=other), "does not match --public-key")
        self.assert_refused(self.publish(public_key=other_public), "does not match --public-key")

    def test_the_release_key_is_refused_even_when_named_as_trusted(self):
        make_feed.RELEASE_PUBLIC_KEY, kept = self.public_key, make_feed.RELEASE_PUBLIC_KEY
        self.addCleanup(setattr, make_feed, "RELEASE_PUBLIC_KEY", kept)
        path = write(self.dir / "source.json", json.dumps(self.source))
        with redirect_stderr(io.StringIO()) as errors:
            code = make_feed.main(["--source", str(path), "--sequence", "1", "--key", str(self.key), "--public-key", self.public_key,
                                   "--base-url", BASE, "--out", str(self.out)])
        self.assertEqual(1, code)
        self.assertIn("is the release key", errors.getvalue())
        self.assertFalse(self.out.exists())

    def test_the_release_key_this_tool_refuses_is_the_one_the_release_signer_trusts(self):
        self.assertIn(make_feed.RELEASE_PUBLIC_KEY, SIGN_FEED.read_text())

    def test_a_missing_or_broken_key_fails_clearly(self):
        self.assert_refused(self.publish(key=self.dir / "none.pem"), "cannot read the key file")
        self.assert_refused(self.publish(key=write(self.dir / "broken.pem", "\n")), "not a readable private key")


class TestKeyTests(Fixture):
    def test_a_test_key_is_private_to_its_owner_at_the_named_path_and_prints_its_public_half(self):
        self.assertEqual(0o600, stat.S_IMODE(self.key.stat().st_mode))
        self.assertEqual(44, len(base64.b64decode(self.public_key, validate=True)))
        self.assertIn("BEGIN PRIVATE KEY", self.key.read_text())
        self.assertEqual(self.public_key, make_feed.public_key_of(self.key))

    def test_a_test_key_never_overwrites_a_file(self):
        before = self.key.read_bytes()
        result = self.run_tool("--generate-test-key", self.key)
        self.assertEqual(1, result.returncode)
        self.assertIn("already exists", result.stderr)
        self.assertEqual(before, self.key.read_bytes())


class GoldenTests(Fixture):
    """The golden file is a sample of what parseCustomGamesFeed reads, so it must stay the shape this tool writes."""

    @staticmethod
    def without_digests(document):
        text = re.sub(r"-[0-9a-f]{12}\.zip", "-DIGEST.zip", json.dumps(document, indent=1, sort_keys=True))
        text = re.sub(r'"sha256": "[0-9a-f]{64}"', '"sha256": "DIGEST"', text)
        return re.sub(r'"bytes": \d+', '"bytes": 0', text)

    def test_the_golden_sample_has_the_shape_the_tool_writes(self):
        golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
        self.assertEqual(self.without_digests(self.published()), self.without_digests(golden))
        self.assertEqual(GOLDEN.read_text(encoding="utf-8"), json.dumps(golden, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    unittest.main()
