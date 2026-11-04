"""Initialize only the dedicated Compose deployment; safely repeat on restart."""
import json
import os
import re
import sys
import time
from pathlib import Path

import psycopg
from scripts.build_load import generate_load_sql, load_and_validate_dataset
from scripts.provision_dashboard import AuthConfig, DashboardProvisioner, MetabaseClient

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'runtime'


def sql_text(text: str) -> str:
    # Verification scripts contain psql-only \set directives. The SQL itself is
    # executed unchanged as a complete script, including dollar-quoted functions.
    return ''.join(line for line in text.splitlines(keepends=True) if not line.startswith('\\'))


class SafeClient(MetabaseClient):
    def request(self, method, path, payload=None, **kwargs):
        try:
            return super().request(method, path, payload, **kwargs)
        except RuntimeError as error:
            status = re.search(r'HTTP (\d+)', str(error))
            raise RuntimeError(f'Metabase {method} {path} failed'
                               + (f' (HTTP {status.group(1)})' if status else '')) from None


def initialize_database() -> None:
    password = (RUNTIME / 'secrets/owner_password').read_text().strip()
    with psycopg.connect(host='postgres', dbname='tour_de_france', user='tdf_owner',
                         password=password, autocommit=True) as conn:
        present = conn.execute("SELECT to_regclass('tdf.result')").fetchone()[0]
        populated = present and conn.execute('SELECT COUNT(*) FROM tdf.result').fetchone()[0] > 0
        conn.execute(sql_text((ROOT / 'sql/001_schema.sql').read_text()))
        if not populated:
            bundle = load_and_validate_dataset(ROOT / 'data')
            conn.execute(sql_text(generate_load_sql(bundle)))
            print('Course CSV data loaded into normalized and star schemas.', flush=True)
        else:
            print('Existing race data retained.', flush=True)
        conn.execute(sql_text((ROOT / 'sql/003_analytics.sql').read_text()))
        for name in ('verify_load.sql', 'verify_analytics.sql'):
            conn.execute(sql_text((ROOT / 'sql' / name).read_text()))
        print('Database and analytical checks passed.', flush=True)


def initialize_metabase(verify: bool = False) -> None:
    credentials = json.loads((RUNTIME / 'admin-credentials.json').read_text())
    client = SafeClient(base_url=os.environ['METABASE_INTERNAL_URL'], timeout_seconds=120,
                        auth=AuthConfig(username=credentials['email'], password=credentials['password']))
    props = client.request('GET', '/api/session/properties', require_auth=False)
    if props.get('setup-token'):
        client.request('POST', '/api/setup', {'token': props['setup-token'], 'user': credentials,
                       'prefs': {'site_name': 'Tour de France Analytics', 'site_locale': 'en',
                                 'allow_tracking': False}}, require_auth=False)
    client.ensure_authenticated()
    databases = client.request('GET', '/api/database')
    database = next((d for d in databases.get('data', [])
                     if d.get('name') == 'Tour de France' and d.get('engine') == 'postgres'), None)
    if database is None:
        database = client.request('POST', '/api/database', {
            'name': 'Tour de France', 'engine': 'postgres',
            'details': {'host': 'postgres', 'port': 5432, 'dbname': 'tour_de_france',
                        'user': 'tdf_reader', 'password': (RUNTIME/'secrets/reader_password').read_text().strip(),
                        'ssl': False, 'tunnel-enabled': False},
            'is_full_sync': True, 'auto_run_queries': True})
    database_id = database['id']
    client.request('POST', f'/api/database/{database_id}/sync_schema', {})
    for _ in range(45):
        meta = client.request('GET', f'/api/database/{database_id}/metadata')
        if len([t for t in meta.get('tables', []) if t.get('schema') == 'dw']) >= 7:
            break
        time.sleep(2)
    else:
        raise RuntimeError('Metabase schema sync timed out; rerun the start script.')
    provisioner = DashboardProvisioner(client, database_id=database_id,
        state_path=RUNTIME/'state/metabase-state.json', portal_base_url=os.environ['PORTAL_PUBLIC_URL'], protected_ids={})
    result = provisioner.provision()
    key = (RUNTIME/'secrets/embedding_secret').read_text().strip()
    client.request('PUT', '/api/setting/enable-embedding-static', {'value': True})
    client.request('PUT', '/api/setting/embedding-secret-key', {'value': key})
    dashboard_id = result['dashboard_id']
    dashboard = client.request('GET', f'/api/dashboard/{dashboard_id}')
    client.request('PUT', f'/api/dashboard/{dashboard_id}', {
        'enable_embedding': True,
        'embedding_params': {p['slug']: 'enabled' for p in dashboard.get('parameters', [])}})
    (RUNTIME/'state/metabase-state.json').chmod(0o644)
    if verify:
        checked = provisioner.verify_cards()
        if checked.get('status') != 'ok':
            raise RuntimeError('One or more native Metabase card queries failed verification.')
        print(f'All {result["card_count"]} native Metabase card queries passed.', flush=True)
    print(f'Metabase ready: {result["tab_count"]} tabs, {result["card_count"]} cards.', flush=True)


def main() -> None:
    initialize_database()
    initialize_metabase(verify='--verify' in sys.argv)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print request payloads, passwords, DSNs or authentication responses.
        if isinstance(error, RuntimeError):
            print(str(error), file=sys.stderr)
        else:
            print(f'Initialization failed ({type(error).__name__}). Check service health and rerun start.', file=sys.stderr)
        sys.exit(1)
