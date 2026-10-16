# Vendored libraries

Kept in the repo (served by GitHub Pages with the app) instead of loaded
from another site, so nobody else's server can change the code the app
runs (GitHub code scanning: "inclusion of functionality from an untrusted
source").

- `xlsx-0.20.3.full.min.js` - SheetJS 0.20.3 (Excel import/export). SheetJS
  only publishes 0.20.x on its own CDN; this copy is from npm
  `@e965/xlsx@0.20.3` (`dist/xlsx.full.min.js`), the same one the tests use.
- `pdf-3.11.174.min.js`, `pdf-3.11.174.worker.min.js` - PDF.js 3.11.174
  (`pdfjs-dist@3.11.174`, `build/`), for reading text out of uploaded PDFs.

To update one, replace the file with the new version (new file name with
the version in it) and change the `<script>` tag in `index.html`.
