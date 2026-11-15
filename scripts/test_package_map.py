#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runtime  # noqa: E402

TOOL = Path(__file__).resolve().parent / "package-map"


class PackageMapTests(unittest.TestCase):
    def test_go_tests_pass(self):
        self.assertTrue((runtime.SOURCE / "go.mod").is_file(), "The runtime's checkout is missing. Run python3 scripts/runtime.py install")
        result = subprocess.run(["go", "test", str(TOOL / "main.go"), str(TOOL / "main_test.go")],
                                cwd=runtime.SOURCE, env=runtime.environment(), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
