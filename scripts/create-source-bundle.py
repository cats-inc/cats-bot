"""Create the complete Bot/Runtime source ZIP from exact Git objects.

Usage: python scripts/create-source-bundle.py BOT_SHA RUNTIME_CHECKOUT OUTPUT_DIR
The Runtime checkout must already be at the tracked runtime-source.json commit.
"""
import base64
import os
import hashlib
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import zipfile

source_commit, runtime_checkout, output = sys.argv[1:]
root = Path.cwd()
runtime = json.loads((root / 'vendor/runtime-source.json').read_text())
version = json.loads((root / 'package.json').read_text())['version']
target = Path(output)
target.mkdir(parents=True, exist_ok=True)
archive = target / f'Cats-Bot-v{version}-source.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as combined:
    for name, checkout, commit in [('cats-bot', root, source_commit), ('cats-runtime', Path(runtime_checkout), runtime['commit'])]:
        actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
        if actual != commit:
            raise RuntimeError(f'{name} checkout is not at the pinned source')
        records = json.loads(subprocess.check_output([
            os.environ.get('CATS_BUILD_NODE', 'node'), str(root / 'scripts/shared/git-source.mjs'),
            str(checkout), commit,
        ], text=True))
        for record in records:
            item = zipfile.ZipInfo(f"{name}/{record['name']}", date_time=(1980, 1, 1, 0, 0, 0))
            item.create_system = 3
            item.compress_type = zipfile.ZIP_DEFLATED
            item.external_attr = int(record['mode'], 8) << 16
            combined.writestr(item, base64.b64decode(record['data'], validate=True))
    combined.writestr('BUILDING.txt', 'See cats-bot/docs/deployment.md. Bot uses the exact Runtime tarball in cats-bot/vendor; the matching Runtime source is included. Run npm ci and npm run build with Node 24. No signing credentials are included.\n')
manifest = {'sourceCommit': source_commit, 'runtimeCommit': runtime['commit'], 'runtimeSha256': runtime['sha256'],
            'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
(target / f'Cats-Bot-v{version}-sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
