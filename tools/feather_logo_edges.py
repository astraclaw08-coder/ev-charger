from PIL import Image

p = 'packages/mobile/assets/branding/lumeo_logo_darktheme-aura.png'
im = Image.open(p).convert('RGBA')
w, h = im.size
px = im.load()

mx = max(24, int(w * 0.08))
my = max(24, int(h * 0.08))

def smoothstep(t: float) -> float:
    if t <= 0:
        return 0.0
    if t >= 1:
        return 1.0
    return t * t * (3 - 2 * t)

for y in range(h):
    dy = min(y, h - 1 - y)
    fy = 1.0 if dy >= my else smoothstep(dy / my)
    for x in range(w):
        dx = min(x, w - 1 - x)
        fx = 1.0 if dx >= mx else smoothstep(dx / mx)
        falloff = min(fx, fy)
        r, g, b, a = px[x, y]
        px[x, y] = (r, g, b, max(0, min(255, int(a * falloff))))

im.save(p)
print(f'Updated {p} ({w}x{h}) with feathered outer edges')
