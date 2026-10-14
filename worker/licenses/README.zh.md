# PDF 组件许可

[English](README.md) | 中文

Worker 发布包应随附本目录。PDF 生成功能新增 gopdf v0.36.0，采用 [MIT](gopdf-MIT.txt)；gofpdi v1.0.14-0.20211212211723-1f10f9844311，采用 [MIT](gofpdi-MIT.txt)；pkg/errors v0.8.1，采用 [BSD-2-Clause](pkg-errors-BSD.txt)。内置的 Corch Report Sans 派生字体保留原始 [SIL 开放字体许可证](font-OFL.txt)。这些声明覆盖 PDF 新增组件，各依赖保留其上游许可。

字体与 HTML 均嵌入 Go 二进制。生产环境不需要浏览器、Python、外部 PDF 服务或额外安装字体。参见[字体来源与复现](../internal/reportview/fonts/README.zh.md)。
