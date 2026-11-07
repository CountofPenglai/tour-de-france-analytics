#!/usr/bin/env python3
"""Export an allowlisted source folder and ZIP, never a live deployment or Git history."""
import argparse
import hashlib
import shutil
import zipfile
from pathlib import Path

ROOT_FILES = {
    'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Dockerfile', 'compose.yaml',
    'requirements.lock.txt', 'start.sh', 'start.ps1', '.env.example',
    '.gitignore', '.dockerignore', '.gitattributes',
}
TREE_SUFFIXES = {
    'web': {'.py', '.html', '.css', '.js', '.svg', '.jpg', '.png', '.md', '.ttf'},
    'sql': {'.sql'}, 'data': {'.csv'}, 'deploy': {'.py', '.sh'},
    'tests': {'.py', '.cjs', '.json', '.sql'},
}
SCRIPTS = {'__init__.py', 'build_load.py', 'provision_dashboard.py', 'benchmark.py', 'package_standard.py'}
DOCS = {'star-schema.md', 'data_dictionary.md', 'analytics.md', 'dashboard.md',
        'portal.md', 'insights.md', 'benchmark.md', 'standard-package-verification.md'}


def collect_files(root: Path) -> list[Path]:
    selected = []
    candidates = [root / name for name in ROOT_FILES]
    candidates += [root / 'scripts' / name for name in SCRIPTS]
    candidates += [root / 'docs' / name for name in DOCS]
    candidates += [root / 'docs/screenshots/team-depth.png', root / 'web/static/assets/fonts/OFL.txt']
    for directory, suffixes in TREE_SUFFIXES.items():
        base = root / directory
        if base.is_symlink():
            raise ValueError(f'Symlink is not allowed in release sources: {directory}')
        if base.exists():
            for path in base.rglob('*'):
                rel = path.relative_to(base)
                if path.is_symlink():
                    raise ValueError(f'Symlink is not allowed in release sources: {path.relative_to(root)}')
                if any(part.startswith('.') or part == '__pycache__' for part in rel.parts):
                    continue
                if path.suffix in suffixes:
                    candidates.append(path)
    for path in candidates:
        if path.is_symlink() or any(p.is_symlink() for p in path.parents if p != root and p.is_relative_to(root)):
            raise ValueError(f'Symlink is not allowed in release sources: {path.relative_to(root)}')
        if path.is_file():
            selected.append(path)
    return sorted(set(selected), key=lambda p: p.relative_to(root).as_posix())


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def export(root: Path, destination: Path) -> tuple[Path, Path]:
    root, destination = root.resolve(), destination.resolve()
    archive = destination.with_suffix('.zip')
    checksum = archive.with_suffix('.zip.sha256')
    if destination.exists() or archive.exists() or checksum.exists():
        raise ValueError('Choose a new output path; an existing release will not be overwritten.')
    required = ROOT_FILES | {'web/static/index.html', 'deploy/bootstrap.py', 'sql/001_schema.sql',
                             'data/riders.csv', 'data/individual_results.csv', 'data/exits.csv'}
    missing = [name for name in required if not (root/name).is_file()]
    if missing:
        raise ValueError('Missing required release sources: ' + ', '.join(sorted(missing)))
    files = collect_files(root)
    destination.mkdir(parents=True)
    for source in files:
        target = destination / source.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o755 if source.suffix == '.sh' else 0o644)
    packaged = sorted(p for p in destination.rglob('*') if p.is_file())
    manifest = destination/'MANIFEST.sha256'
    manifest.write_text(''.join(f'{sha256(p)}  {p.relative_to(destination).as_posix()}\n' for p in packaged))
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
        for path in sorted(p for p in destination.rglob('*') if p.is_file()):
            output.write(path, path.relative_to(destination.parent))
    checksum.write_text(f'{sha256(archive)}  {archive.name}\n')
    return archive, checksum


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='New release directory; existing paths are never overwritten.')
    args=parser.parse_args()
    archive, checksum=export(Path(__file__).resolve().parents[1], args.output)
    print(f'Source folder: {args.output.resolve()}\nZIP: {archive}\nSHA-256: {checksum}')

if __name__=='__main__': main()
