#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 App 图标（全部 PNG + 自适应图标分层）。

    python tools/gen-icon.py

输出到 app/src/main/res/：
  mipmap-{mdpi..xxxhdpi}/ic_launcher.png          圆角方形（API 24-25 与部分启动器）
  mipmap-*/ic_launcher_round.png                   圆形
  mipmap-*/ic_launcher_foreground.png              自适应图标前景（透明，内容在 66/108 安全区内）
  mipmap-*/ic_launcher_background.png              自适应图标背景（满幅渐变）
  mipmap-anydpi-v26/ic_launcher{,_round}.xml       自适应图标描述

造型：白色下载箭头 + 托盘（与界面「下载」tab 同款），底色是 App 主色紫渐变。
改色只动 PALETTE，改造型只动 ARROW。
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

PALETTE = {
    'top': (126, 107, 255),      # #7E6BFF 亮紫
    'bottom': (74, 56, 224),     # #4A38E0 深紫
    'fg': (255, 255, 255),
}

# 箭头几何（1024 基准坐标系；内容 bbox = x 272..752, y 184..838）
ARROW = {
    'stem': [(458, 184), (566, 184), (566, 540), (458, 540)],
    'head': [(512, 730), (286, 452), (738, 452)],
    'tray': [(272, 776), (752, 776), (752, 838), (272, 838)],
    'r_stem': 54,
    'r_head': 40,
    'r_tray': 31,
}
BBOX = (272, 184, 752, 838)   # 箭头内容外框
CX, CY = (BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2

SS = 3  # 超采样倍数
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'app', 'src', 'main', 'res')

LEGACY = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
ADAPTIVE = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}


# ---------------------------------------------------------------- 几何
def _quad(p0, p1, p2, steps):
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


def rounded_polygon(points, radius, steps=24):
    """多边形圆角化：每个顶点沿两边退让，再用二次贝塞尔补圆弧。"""
    out = []
    n = len(points)
    for i in range(n):
        prev, cur, nxt = points[i - 1], points[i], points[(i + 1) % n]
        v1 = (prev[0] - cur[0], prev[1] - cur[1])
        v2 = (nxt[0] - cur[0], nxt[1] - cur[1])
        l1, l2 = math.hypot(*v1), math.hypot(*v2)
        if l1 < 1e-6 or l2 < 1e-6:
            out.append(cur)
            continue
        v1 = (v1[0] / l1, v1[1] / l1)
        v2 = (v2[0] / l2, v2[1] / l2)
        dot = max(-1.0, min(1.0, v1[0] * v2[0] + v1[1] * v2[1]))
        ang = math.acos(dot)
        d = radius / math.tan(ang / 2) if ang > 1e-3 else 0.0
        d = min(d, l1 * 0.5, l2 * 0.5)
        out.extend(_quad((cur[0] + v1[0] * d, cur[1] + v1[1] * d), cur,
                         (cur[0] + v2[0] * d, cur[1] + v2[1] * d), steps))
    return out


# ---------------------------------------------------------------- 素材
def make_arrow(size):
    """白色箭头，内容撑满 size×size，透明底。"""
    scale = size / (BBOX[3] - BBOX[1])

    def tx(x, y):
        return ((x - CX) * scale + size / 2, (y - CY) * scale + size / 2)

    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for key, rkey in (('stem', 'r_stem'), ('head', 'r_head'), ('tray', 'r_tray')):
        pts = [tx(x, y) for x, y in ARROW[key]]
        d.polygon(rounded_polygon(pts, ARROW[rkey] * scale), fill=PALETTE['fg'] + (255,))
    return img


def make_gradient(size):
    """紫渐变 + 左上高光 + 底部暗角，满幅不透明。"""
    col = Image.new('RGB', (1, size))
    top, bot = PALETTE['top'], PALETTE['bottom']
    for y in range(size):
        t = (y / (size - 1)) ** 0.92
        col.putpixel((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    img = col.resize((size, size), Image.BILINEAR).convert('RGBA')

    glow = Image.new('L', (size, size), 0)
    r = size * 0.62
    ImageDraw.Draw(glow).ellipse([-r * 0.42, -r * 0.52, r * 0.62, r * 0.52], fill=52)
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.09))
    img = Image.composite(Image.new('RGBA', (size, size), (255, 255, 255, 255)), img, glow)

    shade = Image.new('L', (size, size), 0)
    ImageDraw.Draw(shade).rectangle([0, int(size * 0.55), size, size], fill=44)
    shade = shade.filter(ImageFilter.GaussianBlur(size * 0.12))
    img = Image.composite(Image.new('RGBA', (size, size), (28, 16, 96, 255)), img, shade)
    return img


def compose(size, shape, arrow_ratio):
    """超采样合成：底色 + 遮罩 + 居中箭头，最后缩到 size。"""
    s = size * SS
    canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    mask = Image.new('L', (s, s), 0)
    md = ImageDraw.Draw(mask)
    if shape == 'square':
        md.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.225), fill=255)
    else:
        md.ellipse([0, 0, s - 1, s - 1], fill=255)
    canvas.paste(make_gradient(s), (0, 0), mask)

    th = int(s * arrow_ratio)
    art = make_arrow(th)
    canvas.alpha_composite(art, ((s - th) // 2, (s - th) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def make_foreground(size):
    """自适应前景：箭头占画布 42%（可见区 72/108 的 ~68%），透明底。

    自适应图标可见区只有中间 72dp，安全圆 66dp；内容超过 61% 就会被裁到边。
    """
    s = size * SS
    canvas = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    th = int(s * 0.42)
    canvas.alpha_composite(make_arrow(th), ((s - th) // 2, (s - th) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def make_adaptive_mock(size):
    """模拟启动器渲染自适应图标：满幅背景 + 前景，裁到中间 72/108 再切圆。"""
    s = size * SS
    canvas = make_gradient(s)
    fg = make_foreground(s)
    canvas.alpha_composite(fg)
    inner = int(s * 72 / 108)
    canvas = canvas.crop(((s - inner) // 2, (s - inner) // 2,
                          (s + inner) // 2, (s + inner) // 2))
    mask = Image.new('L', (inner, inner), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, inner - 1, inner - 1], fill=255)
    out = Image.new('RGBA', (inner, inner), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def save(img, folder, name):
    d = os.path.join(RES, folder)
    os.makedirs(d, exist_ok=True)
    img.save(os.path.join(d, name), 'PNG', optimize=True)


def main():
    for dens, px in LEGACY.items():
        save(compose(px, 'square', 0.63), 'mipmap-' + dens, 'ic_launcher.png')
        save(compose(px, 'round', 0.60), 'mipmap-' + dens, 'ic_launcher_round.png')

    for dens, px in ADAPTIVE.items():
        save(make_foreground(px), 'mipmap-' + dens, 'ic_launcher_foreground.png')
        save(make_gradient(px), 'mipmap-' + dens, 'ic_launcher_background.png')

    anydpi = os.path.join(RES, 'mipmap-anydpi-v26')
    os.makedirs(anydpi, exist_ok=True)
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
           '    <background android:drawable="@mipmap/ic_launcher_background" />\n'
           '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
           '</adaptive-icon>\n')
    for name in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        with open(os.path.join(anydpi, name), 'w', encoding='utf-8', newline='\n') as f:
            f.write(xml)

    # 预览图（不打进 APK）：圆角方形 / 圆形 / 自适应模拟，附实际小尺寸
    sq, rd = compose(320, 'square', 0.63), compose(320, 'round', 0.60)
    ad = make_adaptive_mock(320)
    prev = Image.new('RGBA', (1180, 720), (245, 246, 250, 255))
    for i, art in enumerate((sq, rd, ad)):
        prev.alpha_composite(art, (40 + i * 360, 40))

    prev.alpha_composite(Image.new('RGBA', (1180, 320), (16, 18, 24, 255)), (0, 400))
    for i, art in enumerate((sq, rd, ad)):
        prev.alpha_composite(art.resize((200, 200), Image.LANCZOS), (40 + i * 220, 440))
    for r, maker in enumerate((lambda p: compose(p, 'square', 0.63),
                               lambda p: compose(p, 'round', 0.60))):
        x = 740
        for px in (96, 72, 48):
            prev.alpha_composite(maker(px), (x, 440 + r * 110))
            x += px + 28

    os.makedirs(os.path.join(ROOT, 'docs'), exist_ok=True)
    prev.save(os.path.join(ROOT, 'docs', 'icon-preview.png'), 'PNG', optimize=True)
    print('icon generated ->', RES)


if __name__ == '__main__':
    main()
