# @deepseek-ai/dsh-client-ui-brand-corch2

English | [中文](README.zh.md)

Browser branding for the Corch DSH desktop profile. The plugin occupies the sidebar name and mark slots and the blank-session headline and mark slots. It renders the sidebar label `Corch DSH`, the headline `Corch`, and the suffix `//orchestrate your daily work.`; both mark occupants are empty. The host entry contributes no services and accepts no configuration.

The browser entry requires the runtime, conversation, and sidebar plugins. Its stylesheet link loads Bebas Neue from `https://fonts.loli.net`; disposing the plugin removes that owned link.

## Model Experience

None, as the plugin only renders browser branding and registers no model-facing content.

#### KV Cache effect

None; branding does not assemble or send model requests.

## Known Limitations and Deferred Work

- **External font dependency** — an unavailable font host leaves the text on the sans-serif fallback; the package does not bundle the font.
