"""Builds a WOFF icon font from 16 x 16 SVGs: strokes become outlines, and glyph N gets code point U+E000 + N."""
import sys
from pathlib import Path

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path
from picosvg.svg import SVG

UNITS = 1024
SCALE = UNITS / 16


def glyph(svg_file: Path):
    svg = SVG.fromstring(svg_file.read_text().replace('currentColor', '#000')).topicosvg()
    shapes = []
    for shape in svg.shapes():
        path = pathops.Path()
        parse_path(shape.as_path().d, path.getPen())
        shapes.append(path)
    union = pathops.Path()
    pathops.union(shapes, union.getPen())
    pen = TTGlyphPen(None)
    union.draw(ReverseContourPen(Cu2QuPen(TransformPen(pen, (SCALE, 0, 0, -SCALE, 0, UNITS)), max_err=1)))
    return pen.glyph()


def main(svg_dir: str, out: str, *names: str) -> None:
    order = ['.notdef', *names]
    glyphs = {'.notdef': TTGlyphPen(None).glyph()}
    glyphs.update({name: glyph(Path(svg_dir) / f'{name}.svg') for name in names})
    font = FontBuilder(UNITS, isTTF=True)
    font.setupGlyphOrder(order)
    font.setupCharacterMap({0xE000 + index: name for index, name in enumerate(names)})
    font.setupGlyf(glyphs)
    font.setupHorizontalMetrics({name: (UNITS, 0) for name in order})
    font.setupHorizontalHeader(ascent=UNITS, descent=0)
    font.setupNameTable({'familyName': 'DiffGuide Icons', 'styleName': 'Regular'})
    font.setupOS2(sTypoAscender=UNITS, sTypoDescender=0, usWinAscent=UNITS, usWinDescent=0)
    font.setupPost()
    font.font.flavor = 'woff'
    font.save(out)


if __name__ == '__main__':
    main(*sys.argv[1:])
