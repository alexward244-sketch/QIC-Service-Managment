# Winterizing section maps

`maps/*.jpg` and the `WINTER_MAPS` data in `index.html` are cut from the
park's large map PDF ("Quintes_Isle_Campark - Large Map 20x16 2021 PROOF
MARCH 19.pdf", a vector file - site numbers are text with positions).

To rebuild after the map changes (needs `pip install pymupdf`):

```
python3 extract.py MAP.pdf tokens.json      # every label and where it sits
python3 gen.py MAP.pdf tokens.json OUT_DIR   # section images + OUT_DIR/maps.json
```

Then copy `OUT_DIR/*.jpg` to `maps/` and paste `maps.json` over the
`const WINTER_MAPS = [...]` line in `index.html`.

Notes:
- Some numbers in the Front of Park circle are drawn as shapes, not text;
  their positions are set by hand in `gen.py` (`DRAWN`).
- The map prints 1008 and 1013 twice; `gen.py` treats the top-row 1008 as
  1009 and the 1013 in the even column as 1014.
- Check the result by drawing a circle on every pin (see `gen.py` output)
  before shipping.
