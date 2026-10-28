"""Create the complete Bot/Runtime source ZIP from exact Git objects.

Usage: python scripts/create-source-bundle.py BOT_SHA RUNTIME_CHECKOUT OUTPUT_DIR
The Runtime checkout must already be at the tracked runtime-source.json commit.
"""
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
    for name, checkout, commit in [('cats-bots', root, source_commit), ('cats-runtime', Path(runtime_checkout), runtime['commit'])]:
        actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
        if actual != commit:
            raise RuntimeError(f'{name} checkout is not at the pinned source')
        data = subprocess.check_output(['git', 'archive', '--format=zip', commit], cwd=checkout)
        with zipfile.ZipFile(io.BytesIO(data)) as source:
            for item in source.infolist():
                contents = source.read(item)
                item = copy.copy(item)
                item.filename = f'{name}/{item.filename}'
                combined.writestr(item, contents)
    combined.writestr('BUILDING.txt', 'See cats-bots/docs/deployment.md. Bot uses the exact Runtime tarball in cats-bots/vendor; the matching Runtime source is included. Run npm ci and npm run build with Node 24. No signing credentials are included.\n')
manifest = {'sourceCommit': source_commit, 'runtimeCommit': runtime['commit'], 'runtimeSha256': runtime['sha256'],
            'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
(target / f'Cats-Bot-v{version}-sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
