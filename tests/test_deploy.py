"""Standard package deployment invariants; never use real credentials."""
import tempfile
import unittest
from pathlib import Path

class DeploymentTests(unittest.TestCase):
    def test_runtime_credentials_are_generated_once_and_not_rotated(self):
        from deploy.runtime import initialize_runtime
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            initialize_runtime(root, 'review@example.invalid')
            files={p.relative_to(root):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            initialize_runtime(root, 'review@example.invalid')
            self.assertEqual(files,{p.relative_to(root):p.read_bytes() for p in root.rglob('*') if p.is_file()})
            self.assertNotEqual(files[Path('secrets/owner_password')],files[Path('secrets/reader_password')])
            self.assertGreaterEqual(len(files[Path('secrets/embedding_secret')]),64)
    def test_missing_existing_credentials_fail_instead_of_rotating(self):
        from deploy.runtime import initialize_runtime
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);initialize_runtime(root, 'review@example.invalid')
            (root/'secrets/reader_password').unlink()
            with self.assertRaisesRegex(RuntimeError,'missing'):
                initialize_runtime(root, 'review@example.invalid')
    @unittest.skipIf(__import__('os').name != 'posix', 'POSIX launcher')
    def test_shell_launcher_persists_host_owner_for_later_compose_commands(self):
        import os, shutil, subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copyfile(Path(__file__).resolve().parents[1]/'start.sh', root/'start.sh')
            (root/'.env').write_text('PORTAL_PORT=18000\nLOCAL_UID=99999\nLOCAL_GID=99999\n')
            # A shell function also works when the container's /tmp is noexec.
            stub=root/'stub.sh';stub.write_text('docker() { return 0; }\n')
            result=subprocess.run(['bash',str(root/'start.sh')],capture_output=True,text=True,
                           env={**os.environ,'BASH_ENV':str(stub)})
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            config=(root/'.env').read_text()
            self.assertIn('PORTAL_PORT=18000',config)
            self.assertIn(f'LOCAL_UID={os.getuid()}\n',config)
            self.assertIn(f'LOCAL_GID={os.getgid()}\n',config)
            self.assertNotIn('99999',config)

    def test_portal_settings_use_generated_ids_and_browser_urls(self):
        from deploy.portal import portal_environment
        state={'dashboard_id':9,'tabs':{'tab_overview':21,'tab_classifications':22,'tab_performance':23,'tab_country':24,'tab_insights':25}}
        env=portal_environment(state,'http://127.0.0.1:13000')
        self.assertEqual(env['MB_DASHBOARD_ID'],'9')
        self.assertEqual(env['MB_URL'],'http://127.0.0.1:13000')
        self.assertIn('21',env['MB_TABS_JSON'])
        self.assertEqual(env['DATABASE_URL_FILE'],'/run/secrets/reader_database_url')
    def test_psql_directives_removed_but_sql_and_dollar_bodies_preserved(self):
        from deploy.bootstrap import sql_text
        original='\\set ON_ERROR_STOP on\nDO $$ BEGIN RAISE NOTICE \'ok\'; END $$;\n'
        self.assertEqual(sql_text(original),"DO $$ BEGIN RAISE NOTICE 'ok'; END $$;\n")

if __name__=='__main__':unittest.main()
