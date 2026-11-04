"""Release export must never inherit private deployment state."""
import tempfile
import unittest
from pathlib import Path
from scripts.package_standard import collect_files

class StandardPackageTests(unittest.TestCase):
    def test_export_excludes_secrets_build_outputs_and_unknown_files(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            names=['README.md','.env.example','compose.yaml','web/app.py','web/.env','web/debug.log','web/__pycache__/app.pyc','data/riders.csv','.runtime/secrets/key','.env','.git/config','build/state.json','coordination/private.json','unlisted.txt']
            for name in names:
                p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('fixture')
            actual={p.relative_to(root).as_posix() for p in collect_files(root)}
            self.assertEqual(actual,{'README.md','.env.example','compose.yaml','web/app.py','data/riders.csv'})
    def test_export_rejects_symlinks_even_in_allowed_folders(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'web').mkdir();(root/'private').write_text('secret')
            (root/'web/leak.py').symlink_to(root/'private')
            with self.assertRaisesRegex(ValueError,'[Ss]ymlink'):
                collect_files(root)

if __name__=='__main__': unittest.main()
