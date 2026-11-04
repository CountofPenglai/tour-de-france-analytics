"""Create per-installation secrets without copying the developer's private state."""
import json
import os
import secrets
from pathlib import Path

SECRET_NAMES = ('postgres_password', 'metabase_password', 'owner_password',
                'reader_password', 'metabase_encryption_key', 'embedding_secret',
                'reader_database_url')


def write_new(path: Path, value: str, mode: int = 0o644) -> None:
    if path.exists():
        return
    # Private parent folder protects host access; individual mounted secret files
    # must be readable by PostgreSQL/Metabase's different container user IDs.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'w') as stream:
        stream.write(value)
    path.chmod(mode)


def initialize_runtime(root: Path, email: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    secret_dir = root / 'secrets'
    secret_dir.mkdir(exist_ok=True, mode=0o700)
    state_dir = root / 'state'
    state_dir.mkdir(exist_ok=True, mode=0o755)
    state_dir.chmod(0o755)
    marker = root / 'initialized.json'
    expected = [secret_dir / name for name in SECRET_NAMES] + [root / 'admin-credentials.json']
    if marker.exists():
        missing = [p.name for p in expected if not p.is_file() or not p.stat().st_size]
        if missing:
            raise RuntimeError('Existing installation credentials missing: ' + ', '.join(missing)
                               + '. Restore the original .runtime folder; keys will not be rotated.')
        return
    for name in SECRET_NAMES[:-1]:
        write_new(secret_dir / name, secrets.token_hex(32) + '\n')
    password = (secret_dir / 'reader_password').read_text().strip()
    write_new(secret_dir / 'reader_database_url',
              f'postgresql://tdf_reader:{password}@postgres:5432/tour_de_france\n')
    write_new(root / 'admin-credentials.json', json.dumps({
        'first_name': 'Tour', 'last_name': 'Administrator', 'email': email,
        'password': 'Tdf-' + secrets.token_urlsafe(30) + '-9aA',
    }, indent=2) + '\n', 0o600)
    write_new(marker, json.dumps({'format': 1, 'note': 'Do not delete while retaining the database volume.'}) + '\n', 0o600)


if __name__ == '__main__':
    initialize_runtime(Path('/app/runtime'), os.environ.get('ADMIN_EMAIL', 'admin@tdf.local'))
    print('Private runtime configuration ready. Credentials: .runtime/admin-credentials.json')
