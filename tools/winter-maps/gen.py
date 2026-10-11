# Cuts section maps out of the park map PDF and records where each site's
# number sits on them (as fractions of the image), for index.html.
import pymupdf, json, re, sys, statistics
PDF, TOKENS, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
tokens = json.load(open(TOKENS))
def norm(t):
    t = t.upper().lstrip('0')
    return t
# Numbers drawn as shapes (not text) in the front circle, placed by eye (PDF points).
DRAWN = {"5": (270, 620), "7": (267, 562), "8": (272.5, 559.5), "21": (278.75, 553.75), "22": (285, 563), "23": (288.75, 573),
         "23A": (290, 583), "24A": (287.5, 598), "24": (287.5, 608.75), "25": (282.5, 617.5), "26": (276.25, 625.5),
         "33": (200, 635.5), "34": (193.75, 630.5), "68": (210.5, 503), "69": (218, 502.5), "84": (310, 634.5), "85": (303.75, 640.5),
         "86": (298.75, 646.25), "87": (287, 658), "88": (280, 661), "96": (198.75, 667), "97": (192, 665), "98": (184.5, 661.25),
         "99": (177, 657.5), "100": (171, 652.5)}
def num(t):
    m = re.fullmatch(r'(\d+)([A-Z]?)', t); return int(m.group(1)) if m else None
SECTIONS = [
    ("front-of-park", "Front of Park", lambda t: (num(t) is not None and (1 <= num(t) <= 256 or 301 <= num(t) <= 336)) or t in ("A", "B", "C", "D", "K1", "K2", "K3", "K4", "K5")),
    ("four-season", "4 Season", lambda t: num(t) is not None and 400 <= num(t) <= 470),
    ("limestone-south", "Limestone South", lambda t: num(t) is not None and 483 <= num(t) <= 575),
    ("pebble-beach-east", "Pebble Beach East", lambda t: num(t) is not None and 601 <= num(t) <= 658),
    ("pebble-beach-west", "Pebble Beach West & By the Woods", lambda t: num(t) is not None and (1000 <= num(t) <= 1207 or 1300 <= num(t) <= 1338)),
]
d = pymupdf.open(PDF); page = d[0]
out = []
for key, name, test in SECTIONS:
    pts = {}
    for tk in tokens:
        t = norm(tk['t'])
        if re.fullmatch(r'\d{1,4}[A-Z]?|[A-D]|K\d', t) and test(t):
            pts.setdefault(t, []).append((tk['x'], tk['y'], max(tk['w'], tk['h'])))
    if key == "front-of-park":
        for t, (x, y) in DRAWN.items(): pts.setdefault(t, []).append((x, y, 7))
    # The map prints 1008 and 1013 twice; by the numbering pattern the top-row
    # 1008 is 1009 and the 1013 in the even column is 1014.
    if key == "pebble-beach-west":
        for dup, upper_is, lower_is in (("1008", "1009", "1008"), ("1013", "1013", "1014")):
            two = sorted(pts.pop(dup, []), key=lambda p: p[1])
            if len(two) == 2:
                pts[upper_is] = [two[0]]; pts[lower_is] = [two[1]]
    # Drop strays far from the section (phone numbers, legend): keep the copy nearest the median.
    mx = statistics.median(v[0][0] for v in pts.values()); my = statistics.median(v[0][1] for v in pts.values())
    for t in list(pts):
        pts[t] = min(pts[t], key=lambda p: (p[0] - mx) ** 2 + (p[1] - my) ** 2)
    xs = sorted(p[0] for p in pts.values()); ys = sorted(p[1] for p in pts.values())
    spread = lambda a: (a[int(len(a) * .02)], a[int(len(a) * .98) - 1])
    (lx, hx), (ly, hy) = spread(xs), spread(ys)
    padx, pady = (hx - lx) * .12 + 25, (hy - ly) * .12 + 25
    for t in [t for t, p in pts.items() if not (lx - padx <= p[0] <= hx + padx and ly - pady <= p[1] <= hy + pady)]:
        print(key, "dropping stray", t, pts[t]); del pts[t]
    x0 = min(p[0] for p in pts.values()) - 22; x1 = max(p[0] for p in pts.values()) + 22
    y0 = min(p[1] for p in pts.values()) - 22; y1 = max(p[1] for p in pts.values()) + 22
    clip = pymupdf.Rect(x0, y0, x1, y1)
    pm = page.get_pixmap(dpi=220, clip=clip)
    fname = f"{key}.jpg"
    pm.save(f"{OUT}/{fname}", jpg_quality=82)
    w, h = x1 - x0, y1 - y0
    pins = {t: [round((p[0] - x0) / w, 4), round((p[1] - y0) / h, 4)] for t, p in sorted(pts.items(), key=lambda kv: (num(kv[0]) or 0, kv[0]))}
    r = round(statistics.median(p[2] for p in pts.values()) / w * 0.75, 4)
    out.append({"key": key, "name": name, "file": f"maps/{fname}", "width": pm.width, "height": pm.height, "r": r, "pins": pins})
    print(key, len(pins), "sites", pm.width, "x", pm.height)
json.dump(out, open(f"{OUT}/maps.json", "w"), separators=(",", ":"))
