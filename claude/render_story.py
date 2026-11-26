#!/usr/bin/env python3
"""Uso: render_story.py pieza.json salida.jpg
pieza.json = {"alto":1920|1350, "datos":{...}, "ajustes":{...}, "fondo_img":"data:image/jpeg;base64,...", "dia_filtro":""}
Un JSON por diapositiva (alto 1920 para Story, 1350 para Post/Carrusel). Salida: JPG RGB 1080 x alto, calidad 92."""
import sys, json, subprocess, tempfile, os, shutil
from PIL import Image
pieza, out = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
tpl = open(os.path.join(here, 'render-story.html'), encoding='utf-8').read()
obj = json.load(open(pieza, encoding='utf-8'))
alto = int(obj.get('alto') or 1920)
data = json.dumps(obj, ensure_ascii=False).replace('</', '<\\/')
tmp = tempfile.mkdtemp()
h = os.path.join(tmp, 'p.html'); png = os.path.join(tmp, 'p.png')
open(h, 'w', encoding='utf-8').write(tpl.replace('__PIEZA__', data))
chrome = shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
subprocess.run([chrome, '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                f'--window-size=1080,{alto}', '--virtual-time-budget=5000', f'--screenshot={png}', 'file://' + h],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
im = Image.open(png).convert('RGB')
im = im.crop((0, 0, 1080, alto)) if im.size[1] >= alto else im.resize((1080, alto))
im.save(out, 'JPEG', quality=92, optimize=True)
print(out, os.path.getsize(out), im.size)
