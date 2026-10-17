#!/usr/bin/env python3
"""Check APK ZIP integrity and exact bundled web payload (stdlib only)."""
from pathlib import Path
import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

apk = Path(sys.argv[1])
root = Path(__file__).resolve().parents[1]
with zipfile.ZipFile(apk) as archive:
    assert archive.testzip() is None, 'APK has a corrupt ZIP entry'
    names = set(archive.namelist())
    for name in ('AndroidManifest.xml', 'classes.dex', 'resources.arsc', 'assets/web/index.html'):
        assert name in names, f'Missing APK entry: {name}'
    assert not any(name.startswith('lib/') for name in names), 'Expected ABI-neutral Java/WebView APK'
    count = 0
    files = []
    for source in sorted((root / 'android/build/assets/web').rglob('*')):
        if source.is_file():
            entry = 'assets/web/' + source.relative_to(root / 'android/build/assets/web').as_posix()
            assert source.read_bytes() == archive.read(entry), f'Bundled asset mismatch: {entry}'
            files.append({'path': source.relative_to(root / 'android/build/assets/web').as_posix(),
                          'size_bytes': source.stat().st_size,
                          'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
            count += 1
    bootstrap = root / 'android/app/src/main/assets/diagnostics-bootstrap.js'
    assert archive.read('assets/diagnostics-bootstrap.js') == bootstrap.read_bytes(), 'Native bridge bootstrap mismatch'
    dex = archive.read('classes.dex')
    assert dex.startswith(b'dex\n'), 'Invalid DEX header'
    assert b'Ldev/dot/rosviewer/MainActivity;' in dex, 'MainActivity is missing from DEX'
manifest = ET.parse(root / 'android/app/src/main/AndroidManifest.xml').getroot()
ns = '{http://schemas.android.com/apk/res/android}'
badging = (apk.parent / 'manifest-report.txt').read_text()
package_line = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.M)
assert package_line, 'Unable to read built APK package/version metadata'
assert package_line.groups() == (manifest.attrib['package'], manifest.attrib[ns + 'versionCode'], manifest.attrib[ns + 'versionName']), 'Built APK package/version mismatch'
assert ("minSdkVersion:'24'" in badging or "sdkVersion:'24'" in badging) and "targetSdkVersion:'35'" in badging, 'Built APK SDK mismatch'
permissions = re.findall(r"^uses-permission: name='([^']+)'", badging, re.M)
assert permissions == ['android.permission.INTERNET'], 'Unexpected Android permissions'
bootstrap_hash = hashlib.sha256(bootstrap.read_bytes()).hexdigest()
metadata = {'application_id': manifest.attrib['package'],
            'version_name': manifest.attrib[ns + 'versionName'],
            'version_code': int(manifest.attrib[ns + 'versionCode']),
            'minimum_sdk': 24, 'target_sdk': 35, 'abi': 'universal (Java/DEX; no native libraries)',
            'apk_filename': apk.name, 'apk_size_bytes': apk.stat().st_size,
            'apk_sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
            'bundled_web_files': files,
            'native_diagnostics_bootstrap_sha256': bootstrap_hash,
            'checks': {'zip_integrity': True, 'bundled_web_bytes_match_build_snapshot': True,
                       'dex_header_and_activity_present': True,
                       'manifest_package_version_sdk_and_internet_only': True,
                       'native_diagnostics_bootstrap_matches': True},
            'device_tested': False}
(apk.parent / 'build-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(f'APK ZIP, DEX, manifest presence and {count} bundled web files verified.')
