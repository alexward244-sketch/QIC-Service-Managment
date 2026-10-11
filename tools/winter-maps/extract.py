import pymupdf, re, json, sys, math
PDF = sys.argv[1]
d = pymupdf.open(PDF); p = d[0]
chars = []
for b in p.get_text('rawdict')['blocks']:
    for l in b.get('lines', []):
        dx, dy = l['dir']
        for s in l['spans']:
            for c in s['chars']:
                ch = c['c']
                if re.fullmatch(r'[0-9A-Za-z]', ch):
                    x0, y0, x1, y1 = c['bbox']
                    chars.append(dict(c=ch, bbox=(x0, y0, x1, y1), dir=(round(dx, 2), round(dy, 2)), size=s['size'], origin=c['origin']))
# union chars that sit next to each other along the same writing direction
n = len(chars); parent = list(range(n))
def find(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]; i = parent[i]
    return i
def center(c):
    x0, y0, x1, y1 = c['bbox']; return ((x0 + x1) / 2, (y0 + y1) / 2)
for i in range(n):
    a = chars[i]; ca = center(a)
    for j in range(i + 1, n):
        b = chars[j]
        if abs(a['size'] - b['size']) > 0.6: continue
        cb = center(b)
        dist = math.hypot(ca[0] - cb[0], ca[1] - cb[1])
        if dist > a['size'] * 0.75: continue
        # must be roughly along the text direction (not the line above/below);
        # on curved labels each digit is turned a little, so average the two.
        ux, uy = (a['dir'][0] + b['dir'][0]) / 2, (a['dir'][1] + b['dir'][1]) / 2
        m = math.hypot(ux, uy) or 1; ux, uy = ux / m, uy / m
        vx, vy = cb[0] - ca[0], cb[1] - ca[1]
        across = abs(-vx * uy + vy * ux)
        if across > a['size'] * 0.35: continue
        parent[find(i)] = find(j)
groups = {}
for i in range(n): groups.setdefault(find(i), []).append(chars[i])
tokens = []
for g in groups.values():
    ux = sum(c['dir'][0] for c in g) / len(g); uy = sum(c['dir'][1] for c in g) / len(g)
    g.sort(key=lambda c: c['origin'][0] * ux + c['origin'][1] * uy)
    t = ''.join(c['c'] for c in g)
    xs = [c['bbox'][0] for c in g] + [c['bbox'][2] for c in g]
    ys = [c['bbox'][1] for c in g] + [c['bbox'][3] for c in g]
    tokens.append(dict(t=t, x=(min(xs) + max(xs)) / 2, y=(min(ys) + max(ys)) / 2, w=max(xs) - min(xs), h=max(ys) - min(ys), size=g[0]['size']))
json.dump(tokens, open(sys.argv[2], 'w'))
site = [t for t in tokens if re.fullmatch(r'\d{1,4}[ab]?|[A-D]|K\d?', t['t'])]
print(len(tokens), 'tokens;', len(site), 'site-like')
