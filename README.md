# Simple Electron + d3 template (JavaScript)

Minimal setup for experimenting with visualizations in Electron using d3.

## Project structure

- `src/main` – Electron main process (`main.js`, `preload.js`)
- `src/html` – HTML entry (`index.html`, optional CSS in `style.css`)
- `src/renderer` – Renderer source (`renderer.js`) and bundled file (`bundle.js`)

## Setup

```bash
npm install
```

## Build and run

- **Build renderer + start Electron**:

```bash
npm start
```

This will:
1. Run webpack to bundle `src/renderer/renderer.js` into `src/renderer/bundle.js`.
2. Start Electron using `src/main/main.js`, which loads `src/html/index.html` and the bundle.

## Where to edit

- Change visualizations in `src/renderer/renderer.js`.
- Adjust HTML in `src/html/index.html`.
- Optional styling in `src/html/style.css`.

The generated `src/renderer/bundle.js` is build output – you normally do not edit it.

