# Report font

English | [中文](README.zh.md)

`CorchReportSans-Regular.ttf` is a static weight-400 derivative of [Google Fonts Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc), renamed to Corch Report Sans. Original copyright and the SIL Open Font License remain in [OFL.txt](OFL.txt). The bundled font contains 30,890 Unicode mappings and is embedded and subset in PDFs; the service needs no installed system font or network font request.

The upstream variable-font SHA-256 is `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`. The bundled font SHA-256 is `33624940e5dec77a27dd2fdc7c8c6b834aebf8e1955a5ca4ab05712521c7c70a`.

For reproduction, install `fonttools==4.66.1` in a development environment, obtain the verified upstream `NotoSansSC[wght].ttf`, then run `python build-font.py <input.ttf> [output.ttf]`. [build-font.py](build-font.py) fixes the weight, family names and font timestamp and verifies both digests. Python and fonttools are not production dependencies. Distribute the [Worker license notices](../../../licenses/README.md) with releases.
