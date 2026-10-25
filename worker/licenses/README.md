# PDF component licenses

English | [中文](README.zh.md)

Include this directory with Worker release bundles. PDF generation adds gopdf v0.36.0 under [MIT](gopdf-MIT.txt), gofpdi v1.0.14-0.20211212211723-1f10f9844311 under [MIT](gofpdi-MIT.txt), and pkg/errors v0.8.1 under [BSD-2-Clause](pkg-errors-BSD.txt). The bundled Corch Report Sans derivative retains the original [SIL Open Font License](font-OFL.txt). These notices cover the PDF additions; dependencies retain their upstream licenses.

The font and HTML are embedded in the Go binary. No browser, Python runtime, external PDF service or runtime font installation is required. See [font provenance and reproduction](../internal/reportview/fonts/README.md).
