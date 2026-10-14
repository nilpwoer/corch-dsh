# 报告字体

[English](README.md) | 中文

`CorchReportSans-Regular.ttf` 由 [Google Fonts Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc) 派生，固定为字重 400，字体族重命名为 Corch Report Sans。原始版权及 SIL 开放字体许可证保留在 [OFL.txt](OFL.txt)。内置字体包含 30,890 个 Unicode 映射，PDF 会嵌入其子集；服务不依赖系统安装字体，也不请求网络字体。

上游可变字体 SHA-256 为 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`。内置字体 SHA-256 为 `33624940e5dec77a27dd2fdc7c8c6b834aebf8e1955a5ca4ab05712521c7c70a`。

复现时，在开发环境安装 `fonttools==4.66.1`，取得校验通过的上游 `NotoSansSC[wght].ttf`，再执行 `python build-font.py <input.ttf> [output.ttf]`。[build-font.py](build-font.py) 固定字重、字体族名称和字体时间戳，并验证输入与输出摘要。Python 和 fonttools 均非生产依赖。发布时随附 [Worker 许可声明](../../../licenses/README.zh.md)。
