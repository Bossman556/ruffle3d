# Contributing to Ruffle3D

Thanks for helping. Ruffle3D is a parametric CAD application for product design, and contributions of every size are welcome: bug reports, fixes, new features, tests, documentation and translations.

By contributing you agree that your contribution is licensed under the project's licence, the [GNU General Public License v3.0 or later](LICENSE).

## Getting started

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/Bossman556/ruffle3d.git
cd ruffle3d
npm install
npm run dev        # the app at http://localhost:5173
npm run desktop    # the desktop app (Electron)
npm test           # all test suites
```

The tests run the real OpenCascade kernel in Node, so they take a few minutes. While you work you can run one suite, for example `node tests/assembly.test.mjs`.

## How the code is organised

| Folder | What's there |
| --- | --- |
| `src/` | The app: UI (`main.js`), viewport (`viewport.js`), sketcher, workspaces (drawing, simulate, manufacture, assemblies) |
| `src/kernel/` | Geometry: `build.js` turns the feature timeline into B-rep shapes with OpenCascade; it runs in a Web Worker (`cad.worker.js`) |
| `src/sketch/` | The 2D sketch model, constraint solver and region finder |
| `src/fea.js` | The simulation solvers: static stress, plasticity, buckling, modal, thermal, topology optimisation |
| `electron/` | The desktop shell |
| `site/` | The website's source pages, built into `website/` by `npm run site:build` |
| `tests/` | Test suites (plain Node scripts, no framework) |
| `scripts/` | Packaging, website build and screenshot capture |

The [README](README.md) describes every feature and how it is implemented, and lists known limitations. Those are good places to start contributing.

## Making a change

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach before you spend time on it.
2. **Fork** the repository and create a branch from `main`.
3. **Write the change** in the style of the surrounding code: plain modern JavaScript (ES modules), no framework, small functions, and comments that explain *why* rather than *what*.
4. **Add or update tests.** Kernel and solver changes need a test in `tests/` that checks real numbers, ideally against a hand calculation or a known result, as the existing suites do.
5. **Run `npm test` and `npm run build`.** Both must pass; the CI check runs them on every pull request.
6. **Update the docs** if you change what users see: the README and the pages in `site/pages/`.
7. **Open a pull request** that describes what changed and why, with a screenshot for UI changes.

## Reporting bugs

Use the **Bug report** issue form. A project file (Project ▸ Download project file) that shows the problem helps most. Please include your operating system, browser or desktop app, and the Ruffle3D version.

Security problems should not be reported in public issues; see [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
