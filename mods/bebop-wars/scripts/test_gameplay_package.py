import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gameplay_package", Path(__file__).with_name("gameplay.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
check_map = module.verify_map


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.project = self.root / "gameplay"
        self.build = self.project / "build"
        self.output = self.root / ".local/gameplay"
        for path in (self.build / "maps", self.output, self.root / ".local/packages"):
            path.mkdir(parents=True, exist_ok=True)
        self.addCleanup(patch.stopall)
        patch.object(module, "ROOT", self.root).start()
        patch.object(module, "PROJECT", self.project).start()
        patch.object(module, "OUTPUT", self.output).start()
        patch.object(module, "AUTHORED", self.root / "content/citadel_addons/bebop_wars").start()
        patch.object(module, "COMPILED", self.root / ".local/compiled/bebop_wars").start()
        patch.object(module, "MAP", self.root / ".local/packages/winter_arena.vpk").start()
        self.manifest = {"version": "0.1.0", "map": "winter_arena", "runtime": "RUNTIME_QUICKJS", "entry": "main.js"}
        (self.build / "mod.json").write_text(json.dumps(self.manifest))
        (self.build / "main.js").write_text("export const test = true")
        (self.build / "maps/winter_arena.vpk").write_bytes(b"verified map")
        (self.build / "arena.lock.json").write_text("{}")
        self.record = {
            "inputsSha256": module.inputs_digest(),
            "entrySha256": module.digest(self.build / "main.js"),
            "mapSha256": module.digest(self.build / "maps/winter_arena.vpk"),
            "contentSha256": module.content_hashes(),
            "metadataSha256": {name: module.digest(self.build / name) for name in module.METADATA},
        }
        self.verified_map = patch.object(module, "verify_map", return_value={"sha256": self.record["mapSha256"]}).start()
        module.write_json(self.output / "build.json", self.record)

    def test_source_change_prevents_using_previous_build(self):
        (self.project / "main.ts").write_text("export const changed = true")
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            module.verify_build()

    def test_development_only_changes_do_not_invalidate_the_mode(self):
        (self.project / "development").mkdir()
        (self.project / "development/main.ts").write_text("export const probe = true")
        (self.project / "rules.test.ts").write_text("test('development only')")
        self.assertEqual(module.verify_build(), self.manifest)

    def test_development_snapshot_does_not_replace_the_mode_build(self):
        sources = {
            "main.ts": "startProduction()",
            "session.ts": "export const session = true",
            "development/main.ts": "startProbe()",
            "rules.test.ts": "test('development only')",
            "maps/winter_arena.vpk": "verified arena",
            "content/layout/hud.xml": "<root />",
        }
        for name, content in sources.items():
            source = self.project / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(content)
        config = {
            "compilerOptions": {"paths": {"modlock": ["../.tools/modlock/js/src/index.ts"]}},
            "include": ["*.ts", "../.tools/modlock/js/src/globals.d.ts"],
        }
        module.write_json(self.project / "tsconfig.json", config)
        (self.project / "mod.json").write_text(json.dumps(self.manifest))
        with module.development_project() as project:
            self.assertEqual((project / "main.ts").read_text(), "import './development/main.ts'\n")
            self.assertEqual((project / "development/main.ts").read_text(), "startProbe()")
            self.assertEqual((project / "session.ts").read_text(), sources["session.ts"])
            self.assertEqual((project / "maps/winter_arena.vpk").read_text(), "verified arena")
            self.assertEqual((project / "content/layout/hud.xml").read_text(), "<root />")
            self.assertFalse((project / "rules.test.ts").exists())
            self.assertFalse((project / "build").exists())
            staged_config = module.read_json(project / "tsconfig.json")
            self.assertEqual(staged_config["compilerOptions"]["paths"]["modlock"],
                             [str(self.root / ".tools/modlock/js/src/index.ts")])
            self.assertIn(str(self.root / ".tools/modlock/js/src/globals.d.ts"), staged_config["include"])
            self.assertIn("development/**/*.ts", staged_config["include"])
        self.assertFalse(project.exists())
        self.assertEqual((self.project / "main.ts").read_text(), "startProduction()")
        self.assertEqual((self.build / "main.js").read_text(), "export const test = true")

    def test_a_new_runtime_pin_prevents_using_previous_build(self):
        pin = self.root / "runtime.json"
        pin.write_text('{"version": "a"}')
        patch.object(module.modlock_runtime, "PIN_PATH", pin).start()
        self.record["inputsSha256"] = module.inputs_digest()
        module.write_json(self.output / "build.json", self.record)
        module.verify_build()
        pin.write_text('{"version": "b"}')
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            module.verify_build()

    def test_changed_map_or_entry_is_refused(self):
        for name in ("maps/winter_arena.vpk", "main.js"):
            with self.subTest(name=name):
                path = self.build / name
                original = path.read_bytes()
                path.write_bytes(b"stale or corrupted")
                with self.assertRaises(ValueError):
                    module.verify_build()
                path.write_bytes(original)

    def test_changed_client_content_is_refused(self):
        resource = self.build / "particles/bebop/icicle.vpcf_c"
        resource.parent.mkdir(parents=True)
        resource.write_bytes(b"new content outside the build")
        with self.assertRaisesRegex(ValueError, "client content differs"):
            module.verify_build()

    def test_changed_rules_or_metadata_is_refused(self):
        for name in module.METADATA:
            with self.subTest(name=name):
                path = self.build / name
                original = path.read_text()
                changed = json.loads(original)
                changed["definitions"] = [{"properties": {"AbilityCooldown": 0}}]
                path.write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, "rules or package metadata changed"):
                    module.verify_build()
                path.write_text(original)

    def test_unverified_arena_refuses_the_old_build(self):
        self.verified_map.side_effect = ValueError("The arena source changed")
        with self.assertRaisesRegex(ValueError, "arena source changed"):
            module.verify_build()

    def test_the_arena_is_checked_against_its_lock_with_the_shared_map_tool(self):
        source = module.AUTHORED / "maps/winter_arena.vmap"
        source.parent.mkdir(parents=True)
        source.write_text("arena source")
        module.MAP.write_bytes(b"packed arena")
        lock = {"sourceSha256": module.digest(source), "packageSha256": module.digest(module.MAP), "resources": 56, "sdkCommit": "sdk"}
        module.write_json(self.project / "arena.lock.json", lock)
        patch.object(module.subprocess, "check_output", return_value="sdk\n").start()
        tool = patch.object(module.modlock_runtime, "map_tool", return_value='{"resources": 56}\n').start()
        self.assertEqual(check_map(), {"resources": 56, "sha256": lock["packageSha256"], "bytes": 12})
        arguments = [str(argument) for argument in tool.call_args.args]
        self.assertEqual(arguments[0], "check")
        self.assertEqual(arguments[-3:], ["-require", "maps/winter_arena/world.vwrld_c", str(module.MAP)])
        for prefix in module.LOCAL_PREFIXES:
            self.assertIn(prefix, arguments)
        tool.return_value = '{"resources": 55}\n'
        with self.assertRaisesRegex(ValueError, "resource count differs"):
            check_map()
        module.MAP.write_bytes(b"repacked arena")
        with self.assertRaisesRegex(ValueError, "differs from arena.lock.json"):
            check_map()

    def test_compiler_success_without_output_cannot_reuse_old_effect(self):
        source = module.AUTHORED / "particles/gameplay/warning.vpcf"
        source.parent.mkdir(parents=True)
        source.write_text("changed effect")
        target = self.root / ".local/compiled/bebop_wars/particles/gameplay/warning.vpcf_c"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"previous compiled output" * 4)
        (self.project / "arena.lock.json").write_text('{"sdkCommit":"test-sdk"}')
        with patch.object(module.subprocess, "run"):
            with self.assertRaisesRegex(ValueError, "compiler did not produce"):
                module.equipment_effects()
        self.assertEqual(target.read_bytes(), b"previous compiled output" * 4)
        self.assertFalse((self.output / "effects.json").exists())

    def test_native_probe_requires_final_success_for_requested_teams(self):
        partial = "[BebopWarsProbe] PASS first Hook lands enemy alive"
        complete = partial + "\n[BebopWarsProbe] PASS complete teams=2v2"
        self.assertFalse(module.probe_passed(partial, 0, "2v2"))
        self.assertFalse(module.probe_passed(complete, 1, "2v2"))
        self.assertFalse(module.probe_passed(complete, 0, "3v3"))
        self.assertFalse(module.probe_passed(complete + "\n[BebopWarsProbe] FAIL cleanup", 0, "2v2"))
        self.assertTrue(module.probe_passed(complete, 0, "2v2"))


if __name__ == "__main__":
    unittest.main()
