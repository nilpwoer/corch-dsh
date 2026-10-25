"""Reproduce the bundled font from the verified public Google Fonts input."""
from pathlib import Path
import hashlib
import sys
import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

if len(sys.argv) not in (2, 3):
    raise SystemExit('Usage: build-font.py <NotoSansSC[wght].ttf> [output.ttf]')
assert fontTools.__version__ == '4.66.1', 'Use fonttools==4.66.1 for reproducible output'
source = Path(sys.argv[1])
assert hashlib.sha256(source.read_bytes()).hexdigest() == 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
font = instantiateVariableFont(TTFont(source), {'wght': 400}, inplace=False)
names = {1: 'Corch Report Sans', 2: 'Regular', 3: 'Corch Report Sans Regular 1.0', 4: 'Corch Report Sans Regular', 6: 'CorchReportSans-Regular', 16: 'Corch Report Sans', 17: 'Regular'}
for record in font['name'].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font['head'].modified = 3874822956
font.recalcTimestamp = False
output = Path(sys.argv[2]) if len(sys.argv) == 3 else Path(__file__).with_name('CorchReportSans-Regular.ttf')
font.save(output)
assert hashlib.sha256(output.read_bytes()).hexdigest() == '33624940e5dec77a27dd2fdc7c8c6b834aebf8e1955a5ca4ab05712521c7c70a'
print('Verified Corch Report Sans Regular font generated.')
