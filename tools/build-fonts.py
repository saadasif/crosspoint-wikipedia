"""Build the optional InterWiki pack. Normal plugin builds use the checked-in pack.

Run with a Python environment containing tools/font-requirements.txt and pass the
firmware checkout to --firmware. All external inputs are checksum verified.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.merge import Merger, Options as MergeOptions
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.ttLib.scaleUpem import scale_upem

ROOT = Path(__file__).resolve().parent.parent
args = argparse.ArgumentParser()
args.add_argument('--firmware', type=Path, required=True)
options = args.parse_args()
inputs = json.loads((ROOT / 'tools/font-inputs.json').read_text())
cache = ROOT / '.context/font-build'
cache.mkdir(parents=True, exist_ok=True)


def verify(path, digest):
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError(f'Font build input checksum mismatch: {path}')
    return path


for relative, digest in inputs['firmware'].items():
    verify(options.firmware / relative, digest)
for name, source in inputs['downloads'].items():
    path = cache / name
    if not path.exists():
        request = urllib.request.Request(source['url'], headers={'User-Agent': 'CrossPoint-Wikipedia-Font-Builder'})
        with urllib.request.urlopen(request, timeout=45) as response:
            path.write_bytes(response.read())
    verify(path, source['sha256'])

# Subset source fonts before instancing. Only cmap glyphs in our declared
# ranges are needed: the reader consumes bitmaps, not OpenType layout tables.
# Reuse each upright weight for italic faces of scripts without an italic design.
downloaded = {}
for script, source in inputs['downloadedFallbacks'].items():
    print(f'Preparing {script} fallback...', flush=True)
    with TTFont(cache / source['file']) as font:
        characters = set(map(ord, source.get('characters', '')))
        codepoints = {cp for cp in font.getBestCmap()
                      if cp in characters or any(start <= cp <= end for start, end in source['ranges'])}
        settings = subset.Options()
        settings.layout_features = []
        sub = subset.Subsetter(options=settings)
        sub.populate(unicodes=codepoints)
        sub.subset(font)
        for weight in [400, 700]:
            axes = {axis.axisTag: (weight if axis.axisTag == 'wght' else axis.defaultValue)
                    for axis in font['fvar'].axes} if 'fvar' in font else {}
            static = instantiateVariableFont(font, axes, optimize=False) if axes else font
            path = cache / f'{script}-{weight}.ttf'
            static.save(path)
            if static is not font:
                static.close()
            downloaded[script, weight] = path

extra_intervals = ''.join(f',(0x{start:X}-0x{end:X})'
                          for source in inputs['downloadedFallbacks'].values()
                          for start, end in [*source['ranges'],
                                             *((ord(c), ord(c)) for c in source.get('characters', ''))])
styles = [('regular', 'Inter.ttf', 400), ('bold', 'Inter.ttf', 700),
          ('italic', 'Inter-Italic.ttf', 400), ('bolditalic', 'Inter-Italic.ttf', 700)]
# U+FDFD's full-phrase calligraphy exceeds CPFONT's 255-pixel glyph width.
command = [sys.executable, str(options.firmware / 'lib/EpdFont/scripts/fontconvert_sdcard.py'),
           '--intervals', ('reading,greek,cyrillic,ipa-chars,(0x1AB0-0x1AFF),(0x1D00-0x1DFF),'
                           '(0x0590-0x05FF),(0x0600-0x06FF),(0x0750-0x077F),(0x0870-0x089F),'
                           '(0x08A0-0x08FF),(0xFB1D-0xFDFC),(0xFDFE-0xFDFF),(0xFE70-0xFEFF),'
                           '(0x2100-0x214F),(0x2300-0x23FF),(0x27C0-0x27FF),(0x2980-0x2AFF),'
                           '(0x2C60-0x2C7F),(0xA700-0xA7FF),(0xAB30-0xAB6F),'
                           '(0x10780-0x107BF),(0x1D45D-0x1D45D),(0x1DF00-0x1DFFF)') + extra_intervals,
           '--sizes', '12,14,16,18',
           '--name', 'InterWiki', '--output-dir', str(cache / 'InterWiki')]
for style, name, weight in styles:
    print(f'Merging {style} fallback...', flush=True)
    with TTFont(cache / name) as source:
        font = instantiateVariableFont(source, {'wght': weight, 'opsz': 14}, optimize=False)
        output = cache / f'{style}.ttf'
        font.save(output)
        font.close()
    fallback = options.firmware / inputs['fallbacks'][style]
    # Use script fonts before Math so partial math-font coverage cannot win.
    # Arabic joining is performed by the reader using encoded presentation forms.
    with TTFont(fallback) as noto:
        covered = set(noto.getBestCmap())
        units_per_em = noto['head'].unitsPerEm
    paths = [str(fallback)]
    weight_name = 'bold' if 'bold' in style else 'regular'
    supplements = [(name, options.firmware / faces[weight_name])
                   for name, faces in inputs['scriptFallbacks'].items()]
    supplements.append(('math', cache / 'NotoSansMath.ttf'))
    supplements.extend((script, downloaded[script, weight]) for script in inputs['downloadedFallbacks'])
    for name, path in supplements:
        with TTFont(path) as extra:
            missing = set(extra.getBestCmap()) - covered
            settings = subset.Options()
            settings.layout_features = []
            sub = subset.Subsetter(options=settings)
            sub.populate(unicodes=missing)
            sub.subset(extra)
            if extra['head'].unitsPerEm != units_per_em:
                scale_upem(extra, units_per_em)
            extra_path = cache / f'{name}-{style}.ttf'
            extra.save(extra_path)
            paths.append(str(extra_path))
            covered.update(missing)
    settings = MergeOptions()
    # CPFONT uses horizontal bitmaps only; vertical metrics are not present
    # in every source font and cannot be merged across those sources.
    settings.drop_tables = ['GSUB', 'GPOS', 'GDEF', 'MATH', 'vhea', 'vmtx', 'VORG', 'BASE', 'STAT']
    merged = Merger(options=settings).merge(paths)
    combined = cache / f'fallback-{style}.ttf'
    merged.save(combined)
    merged.close()
    command.extend([f'--{style}', str(output), f'--fallback-{style}', str(combined)])
subprocess.run(command, check=True)

metadata = {'family': 'InterWiki', 'files': []}
with zipfile.ZipFile(ROOT / 'wikipedia.crosspoint-plugin/inter-fonts.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for size in [12, 14, 16, 18]:
        name = f'InterWiki_{size}.cpfont'
        data = (cache / 'InterWiki' / name).read_bytes()
        metadata['files'].append({'size': size, 'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        info = zipfile.ZipInfo(f'InterWiki/{name}', date_time=(2000, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, data)
    licenses = [('Inter-OFL.txt', cache / 'Inter-OFL.txt'), ('NotoSans-OFL.txt', options.firmware / inputs['notoLicense']), ('NotoSansMath-OFL.txt', cache / 'NotoSansMath-OFL.txt')]
    licenses.extend((name, options.firmware / path) for name, path in inputs['scriptLicenses'].items())
    licenses.extend((name, cache / name) for name in inputs['downloads']
                    if name.endswith('-OFL.txt') and (name, cache / name) not in licenses)
    for name, path in licenses:
        info = zipfile.ZipInfo(f'InterWiki/{name}', date_time=(2000, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, path.read_bytes())
(ROOT / 'src/font-pack.json').write_text(json.dumps(metadata, indent=2) + '\n')
print('Built InterWiki with script fallbacks and selected monochrome symbols.')
