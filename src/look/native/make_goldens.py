"""Native reference outputs for web/src/look's parity tests. Run through regenerate.sh, which builds
native_dump; DUMP names the binary, OUT_DIR overrides testdata/ (for the Apple-libm comparison)."""
import glob, json, os, random, struct, subprocess, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__))
dump = os.environ['DUMP']
out_dir_override = os.environ.get('OUT_DIR')
# the app's folder: the hazel-web repository, or web/ in the project it is developed in
app = os.path.abspath(os.path.join(here, '../../..'))
repo = os.path.dirname(app) if os.path.basename(app) == 'web' else app
collection = os.environ.get('COLLECTION', os.path.join(repo, '../Hazel-film-recipes/recipes'))
out_dir = os.path.join(app, 'src/look/testdata')
out_dir = out_dir_override or out_dir
os.makedirs(out_dir, exist_ok=True)

def run(args, text):
    with tempfile.NamedTemporaryFile('w', delete=False, suffix='.txt') as f:
        f.write(text); path = f.name
    try:
        return subprocess.run([dump, args[0], path, *args[1:]], check=True, capture_output=True).stdout
    finally:
        os.unlink(path)

cases = []
for path in sorted(glob.glob(f'{repo}/recipes/*.txt')):
    cases.append(('recipes/' + os.path.basename(path), open(path).read()))
for path in sorted(glob.glob(f'{collection}/*.txt')):
    cases.append(('collection/' + os.path.basename(path), open(path).read()))
edge = {
    'empty': '',
    'ties': 'contrast = 0.0625\nshadows = -0.0625\nhighlights = 0.1875\nsaturation = -0.4375\ngrade_shadows = 22.25, 0.0625\ngrade_highlights = -37.75, 2\n',
    'near-ties': 'brightness = 0.0005\nfade = 0.0015\nvibrance=-0.0005\nclarity = 0.9995\ngrade_balance = -0.0004999\n',
    'nan-inf': 'contrast = nan\nshadows = inf\nhighlights = -inf\nsaturation = -nan\n',
    'mono-mix': 'mono = 1\nmono_mix = 1, 1, 1\n',
    'mono-mix-tight': 'mono_mix = 0.2,0.3,0.5\n',
    'mono-mix-zero': 'mono_mix = 0, 0, 0\n',
    'film-words': 'film = silver extra\n',
    'film-tight': 'film=muted\n',
    'film-unknown': 'film = Chrome\n',
    'seed-max': 'seed = 4294967295\n',
    'seed-over': 'seed = 4294967296\n',
    'seed-negative': 'seed = -1\n',
    'mixer': 'mix_red = 0.5, -0.25, 2\nmix_magenta = 1e-3, 3.3e-1, .5\nmix_aqua = 0.1, 0.2\nmix_teal = 1, 1, 1\n',
    'spacing': '  contrast   =   .7  \n# comment = 1\nunknown = 3\nsaturation = 1e10\n\tgrain\t=\t0.25\n',
    'hue-wrap': 'grade_shadows = 720.04, 0.5\ngrade_highlights = -0.04, 0.3\n',
    'mono-values': 'mono = 2\n',
    'mono-junk': 'mono = abc\n',
    'crlf': 'contrast = 0.3\r\nshadows = 0.2\r\n',
    'long-line': 'contrast = 0.3' + ' ' * 200 + '\nshadows = 0.25\n',
    'many-digits': 'halation = 0.12345678901234567890123\nsharpness = -0.33333333333333333333\n',
    'exponents': 'contrast = 5e-1\nshadows = -2.5E-1\nhighlights = 1e\nsaturation = .\n',
    'no-newline': 'vignette = 0.42',
    'garbage-value': 'vignette = hello\n',
}
for name, text in edge.items():
    cases.append(('edge/' + name, text))
rng = random.Random(1234)
keys = ['contrast', 'shadows', 'highlights', 'saturation', 'shift_red', 'shift_blue', 'vignette', 'grain',
        'grain_size', 'sharpness', 'clarity', 'aberration', 'dynamic_range', 'colour_depth', 'blue_depth',
        'tone_warm', 'tone_magenta', 'noise_reduction', 'fade', 'brightness', 'vibrance', 'halation', 'grade_balance']
bands = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']
def num():
    return f'{rng.uniform(-1.2, 1.2):.{rng.randint(1, 8)}f}'
for i in range(40):
    lines = [f'{k} = {num()}' for k in rng.sample(keys, rng.randint(1, len(keys)))]
    lines.append(f'grade_shadows = {rng.uniform(-400, 400):.{rng.randint(0, 6)}f}, {num()}')
    lines.append(f'grade_highlights = {rng.uniform(0, 360):.{rng.randint(0, 6)}f}, {num()}')
    for b in rng.sample(bands, rng.randint(0, 8)):
        lines.append(f'mix_{b} = {num()}, {num()}, {num()}')
    lines.append(f'film = {rng.choice(["standard", "muted", "silver"])}')
    lines.append(f'mono = {rng.randint(0, 1)}')
    lines.append(f'mono_mix = {abs(float(num())):.3f}, {abs(float(num())):.4f}, {abs(float(num())) + 0.01:.2f}')
    lines.append(f'seed = {rng.randint(0, 2**32 - 1)}')
    rng.shuffle(lines)
    cases.append((f'fuzz/{i}', '\n'.join(lines) + '\n'))

golden = []
for name, text in cases:
    golden.append({'name': name, 'input': text, 'output': run(['format'], text).decode(),
                   'recognised': int(run(['recognised'], text))})
json.dump(golden, open(os.path.join(out_dir, 'format.json'), 'w'), indent=0)

# pixels and tables for the real recipes and a recipe using every per-pixel setting
everything = ('film = muted\ncontrast = 0.3\nshadows = -0.2\nhighlights = 0.25\nsaturation = 0.2\nshift_red = 0.3\n'
              'shift_blue = -0.2\ndynamic_range = 0.6\ncolour_depth = 0.7\nblue_depth = 0.5\nfade = 0.3\n'
              'brightness = 0.2\nvibrance = 0.4\ngrade_shadows = 200, 0.4\ngrade_highlights = 40, 0.3\n'
              'grade_balance = 0.2\nmix_red = 0.3, 0.2, -0.1\nmix_blue = -0.4, 0.5, 0.2\nmix_green = 0.2, -0.3, 0.1\n')
mono_toned = 'mono = 1\nmono_mix = 0.2, 0.3, 0.5\ncontrast = 0.4\ntone_warm = 0.5\ntone_magenta = -0.3\nfade = 0.2\n'
spatial = ('contrast = 0.2\nvignette = 0.5\ngrain = 0.6\ngrain_size = 0.7\nsharpness = 0.6\nclarity = 0.8\n'
           'aberration = 0.9\nhalation = 0.8\nseed = 77\n')
spatial_soft = 'mono = 1\nvignette = -0.4\ngrain = 0.3\nsharpness = -0.5\nclarity = 0.4\nhalation = 0.5\nseed = 5\n'
pixel_recipes = [(n, t) for n, t in cases if n.startswith(('recipes/', 'collection/'))]
pixel_recipes += [('extra/everything', everything), ('extra/mono-toned', mono_toned)]
manifest = {'pixels': [], 'apply': []}
blob = bytearray()
for name, text in pixel_recipes:
    data = run(['pixels', '5'], text) + run(['table', '5'], text)
    manifest['pixels'].append({'name': name, 'input': text, 'offset': len(blob), 'floats': len(data) // 4})
    blob += data
apply_recipes = [('extra/spatial', spatial), ('extra/spatial-soft', spatial_soft), ('extra/everything', everything)]
apply_recipes += [(n, t) for n, t in pixel_recipes if n in ('collection/tungsten-800t.txt', 'collection/gritty-black-and-white.txt')]
W, H = 32, 24
for name, text in apply_recipes:
    data = run(['apply', str(W), str(H)], text)
    manifest['apply'].append({'name': name, 'input': text, 'width': W, 'height': H, 'offset': len(blob), 'floats': len(data) // 4})
    blob += data
def fnv1a(data):
    h = 0x811c9dc5
    for b in data:
        h = ((h ^ b) * 0x01000193) & 0xffffffff
    return h
manifest['hashes'] = []
manifest['tables'] = [{'name': n, 'input': t, 'n': 33, 'fnv1a': fnv1a(run(['table', '33'], t))} for n, t in pixel_recipes]
BW, BH = 400, 600  # tall enough for sharpness (it needs a 0.35 pixel radius: 584 rows)
for name, text in apply_recipes:
    data = run(['apply', str(BW), str(BH)], text)
    manifest['hashes'].append({'name': name, 'input': text, 'width': BW, 'height': BH, 'fnv1a': fnv1a(data)})
open(os.path.join(out_dir, 'native.bin'), 'wb').write(blob)
json.dump(manifest, open(os.path.join(out_dir, 'native.json'), 'w'), indent=1)
print(len(golden), 'format cases;', len(blob), 'bytes of floats')
