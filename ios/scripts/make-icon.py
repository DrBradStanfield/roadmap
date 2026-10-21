"""Draws the app icon: a white road rising to a heart on a green gradient.
Run: python3 ios/scripts/make-icon.py  (writes the 1024 px AppIcon PNG)."""
import math, os
from PIL import Image, ImageDraw, ImageFilter

S = 4096  # drawn large, then scaled down for smooth edges
OUT = os.path.join(os.path.dirname(__file__), '..', 'HealthRoadmap', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon.png')

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# Diagonal gradient, fresh green at top left to deep teal at bottom right.
top, bottom = (52, 211, 120), (8, 120, 110)
grad = Image.new('RGB', (S, S))
px = grad.load()
for y in range(S):
    for x in range(0, S, 4):
        c = lerp(top, bottom, (x + y) / (2 * S))
        for k in range(4): px[x + k, y] = c
img = grad.convert('RGBA')

def bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return tuple(u**3 * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t**3 * p3[i] for i in range(2))

# The road: an S-curve from the bottom edge up toward the heart, narrowing with distance.
P = [(S * 0.38, S * 1.05), (S * 0.95, S * 0.78), (S * 0.08, S * 0.52), (S * 0.6, S * 0.39)]
road = Image.new('L', (S, S), 0)
d = ImageDraw.Draw(road)
N = 1400
for i in range(N + 1):
    t = i / N
    x, y = bezier(*P, t)
    r = S * (0.15 * (1 - t) + 0.028 * t)
    d.ellipse([x - r, y - r, x + r, y + r], fill=255)
shadow = road.filter(ImageFilter.GaussianBlur(S * 0.02))
img.paste((0, 60, 50, 90), (0, int(S * 0.012)), shadow.point(lambda v: v * 0.45))
img.paste((255, 255, 255, 255), (0, 0), road)

# Dashed centre line in the road's own green.
d2 = ImageDraw.Draw(img)
for i in range(N + 1):
    t = i / N
    if int(t * 11) % 2 == 1 or t > 0.93: continue
    x, y = bezier(*P, t)
    r = S * (0.012 * (1 - t) + 0.004 * t)
    d2.ellipse([x - r, y - r, x + r, y + r], fill=lerp(top, bottom, 0.45) + (255,))

# The heart at the road's end.
def heart(cx, cy, w):
    pts = []
    for k in range(400):
        a = 2 * math.pi * k / 400
        hx = 16 * math.sin(a) ** 3
        hy = 13 * math.cos(a) - 5 * math.cos(2 * a) - 2 * math.cos(3 * a) - math.cos(4 * a)
        pts.append((cx + hx * w / 32, cy - hy * w / 32))
    return pts
hx, hy, hw = S * 0.6, S * 0.22, S * 0.30
hs = Image.new('L', (S, S), 0)
ImageDraw.Draw(hs).polygon(heart(hx, hy + S * 0.015, hw), fill=255)
img.paste((0, 60, 50, 110), (0, 0), hs.filter(ImageFilter.GaussianBlur(S * 0.02)))
ImageDraw.Draw(img).polygon(heart(hx, hy, hw), fill=(255, 255, 255, 255))
ImageDraw.Draw(img).polygon(heart(hx, hy + S * 0.004, hw * 0.72), fill=(255, 69, 88, 255))

img.convert('RGB').resize((1024, 1024), Image.LANCZOS).save(OUT)
print('wrote', os.path.normpath(OUT))
