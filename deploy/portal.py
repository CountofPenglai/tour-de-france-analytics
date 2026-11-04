"""Start FastAPI with the freshly provisioned dashboard IDs and secret files."""
import json
import os
from pathlib import Path

TAB_KEYS = ('tab_overview', 'tab_classifications', 'tab_performance', 'tab_country', 'tab_insights')


def portal_environment(state: dict, metabase_url: str) -> dict[str, str]:
    return {
        'DATABASE_URL_FILE': '/run/secrets/reader_database_url',
        'MB_EMBEDDING_SECRET_KEY_FILE': '/run/secrets/embedding_secret',
        'MB_URL': metabase_url,
        'MB_DASHBOARD_ID': str(state['dashboard_id']),
        'MB_TABS_JSON': json.dumps({str(i+1): state['tabs'][key] for i,key in enumerate(TAB_KEYS)}),
    }


if __name__ == '__main__':
    state = json.loads(Path('/app/runtime/metabase-state.json').read_text())
    os.environ.update(portal_environment(state, os.environ['METABASE_PUBLIC_URL']))
    import uvicorn
    uvicorn.run('web.app:app', host='0.0.0.0', port=8000)
