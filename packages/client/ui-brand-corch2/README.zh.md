# @deepseek-ai/dsh-client-ui-brand-corch2

[English](README.md) | 中文

Corch DSH 桌面配置使用的浏览器品牌插件。插件占据侧栏名称与标记 slot，以及空白会话的标题与标记 slot。侧栏显示 `Corch DSH`，标题显示 `Corch` 及后缀 `//orchestrate your daily work.`；两个标记均为空。Host 入口不提供服务，也不接受配置。

浏览器入口依赖 runtime、conversation 和 sidebar 插件。它通过样式表链接从 `https://fonts.loli.net` 加载 Bebas Neue；释放插件时会移除自有链接。

## 模型体验

无，因为插件只渲染浏览器品牌，不注册模型可见内容。

#### KV Cache 影响

无；品牌呈现不组装或发送模型请求。

## 已知限制与暂缓事项

- **外部字体依赖**：字体主机不可用时，文本使用 sans-serif 回退字体；本包不捆绑字体。
