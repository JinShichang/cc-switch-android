"""Collect exact cached Cargo dependency notices without packaging credentials."""
from pathlib import Path
import json
import tomllib
project=Path(__file__).resolve().parents[1]
lock=tomllib.loads((project/'native/Cargo.lock').read_text(encoding='utf-8'))
registries=list((Path.home()/'.cargo/registry/src').glob('*'))
supplement_dir=project/'licenses/native'
supplements=json.loads((supplement_dir/'sources.json').read_text(encoding='utf-8')) if (supplement_dir/'sources.json').exists() else {}
sections=['CC Switch Android native dependency licenses\nUpstream CC Switch 4.0.40 (MIT, Jason Young).\n\n'+(project/'LICENSE').read_text(encoding='utf-8')]
inventory=[]
missing=[]
for package in sorted(lock['package'],key=lambda p:(p['name'],p['version'])):
    if package['name']=='cc-switch-android-core':continue
    directory=next((r/(package['name']+'-'+package['version']) for r in registries if (r/(package['name']+'-'+package['version'])/'Cargo.toml').is_file()),None)
    if directory is None:
        missing.append(package['name']+' '+package['version'])
        continue # Inactive optional / other-platform dependencies are not in APK.
    details=tomllib.loads((directory/'Cargo.toml').read_text(encoding='utf-8'))['package']
    license_files=[]
    for pattern in ['LICENSE*','LICENCE*','COPYING*','NOTICE*','license*','**/LICENSE*','**/COPYING*']:
        license_files.extend(p for p in directory.glob(pattern) if p.is_file() and p.stat().st_size<1024*1024)
    files=sorted(set(license_files))
    blocks=[]
    for file in files:
        try:blocks.append(file.relative_to(directory).as_posix()+'\n\n'+file.read_text(encoding='utf-8'))
        except UnicodeError:continue
    declared=details.get('license') or details.get('license_file') or 'See package source'
    if not blocks:
        supplement=supplements.get(package['name'])
        if not supplement:raise RuntimeError('Dependency license text missing: '+package['name'])
        blocks.append('Selected license: '+supplement['license']+'\nSource: '+supplement['source']+'\n\n'+(supplement_dir/supplement['file']).read_text(encoding='utf-8'))
    inventory.append({'name':package['name'],'version':package['version'],'license':declared,'repository':details.get('repository'),'noticeFiles':[p.relative_to(directory).as_posix() for p in files] or ['licenses/native/'+supplements[package['name']]['file']]})
    sections.append(package['name']+' '+package['version']+' — '+declared+'\n'+(details.get('repository') or '')+'\n\n'+'\n\n'.join(blocks))
(project/'native/THIRD_PARTY_NOTICES.txt').write_text(('\n\n'+'='*72+'\n\n').join(sections)+'\n',encoding='utf-8')
(project/'native/dependency-licenses.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f'Collected licenses for {len(inventory)} cached dependencies; {len(missing)} inactive/other-platform packages not compiled')
