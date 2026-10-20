# 教改 Worker

[English](README.md) | 中文

本文是独立 Go 服务的参考说明，服务生成访谈追问和关联证据的报告，使用 Cobra、GORM 和 MySQL。HTTP API 面向可信应用后端，可选的回环浏览器入口用于本地联调。独立、显式开启的 portal 提供数据库管理账号、题包上传和访谈会话；回环 preview 保持分离。

## 快速启动

安装 Go 1.25 或更新版本，并创建独立的 MySQL 数据库。实际验收使用 MySQL 8.4；启动时拒绝低于 8.0.13 的 MySQL 和 MariaDB。数据库账号在首次初始化时需要建表权限，之后需要读写权限。

```powershell
cd worker
go build -o teaching-worker.exe .
Copy-Item config.example.yaml config.local.yaml
# 配置 database.dsn、auth.token、providers.deepseek.api_key。
.\teaching-worker.exe serve -c config.local.yaml
```

修改 `providers` 和各提示词的 `model`，使其对应账号可用的接口地址和模型。示例使用 DeepSeek Chat Completions 接口。适配器向 `{base_url}/chat/completions` 发送非流式 JSON 请求；不兼容此协议的服务商需要独立适配器。Linux 下使用 `go build -o teaching-worker .` 编译，再运行 `./teaching-worker serve -c config.local.yaml`。

MySQL 可访问时，`GET /health` 返回 HTTP 200 和 `ready: true`。其他接口需要 `Authorization: Bearer <token>`。共享令牌应保存在应用后端；它可以访问此 Worker 数据库中的全部访谈，不用于识别具体专家。

## 配置

[config.example.yaml](config.example.yaml) 包含完整配置。未知字段、缺失必填值和无效限制会导致启动失败。启动参数（包括凭据和模型选择）从 `serve -c` 指定的 YAML 读取，不读取环境变量。管理端业务提示词和题包策略覆盖单独保存在 MySQL。`config.local.yaml` 已被 Git 忽略。配置在启动时读取，修改后重启生效。

| 分组 | 设置及行为 |
|---|---|
| `mode` | `both` 同时提供 API 和执行任务；`api` 只接收和查询任务；`worker` 只消费任务并提供健康检查。共同部署的进程使用各自的监听地址，并访问同一个数据库。 |
| `server` | 监听地址、读写及关闭超时、HTTP 请求体上限。 |
| `database` | 直接填写的 `dsn`、首次建表、连接池大小、连接生命周期、连接及读写超时。`auto_migrate` 初始化结构版本 4，或为版本 1/2/3 增量添加 portal/runtime/access 表；其他版本拒绝。 |
| `auth` | 直接填写的后端共享 `token`；令牌至少 32 个字符。所有运行模式均必填。 |
| `queue` | 追问和报告分别设置并发数，以及轮询、租约、心跳、任务超时、尝试次数、重试间隔、输入输出字节上限。执行限制按访谈冻结并复制到任务；并发数和轮询间隔属于各运行进程。 |
| `providers` | 命名接口地址、直接填写的 `api_key` 和请求超时。仅 API 模式允许模型密钥为空；消费者要求每个已配置模型都有密钥。 |
| `prompts.followup` | 版本、模型参数、旧后端追问上限、分析提示词和生成提示词。Portal 会话使用题包策略而非此上限。 |
| `prompts.report` | 独立版本和模型、证据提取及报告生成提示词。`max_followups` 为零。 |
| `preview` | 可选的本地浏览器入口、页面及问题包路径、Cookie 有效期、轮询间隔及显示的模型标识。要求 `api` 或 `both` 模式，且监听数值形式的回环 IP。 |

租约时长至少为心跳间隔的三倍。MySQL 连接容量应覆盖全部副本，并为心跳和 API 事务留出空间。任务超时覆盖全部阶段。`max_input_bytes` 还限制包含指令和 schema 的完整模型请求；`max_output_bytes` 限制每次服务商响应及合并后的最终结果。

### 调整提示词

修改对应提示词正文、模型参数或服务商公开设置，为受影响的流程设置新 `version`，然后重启。相同版本对应不同内容时启动失败。每个任务保存输入、版本内容及哈希；配置变化后，重试仍使用原版本。凭据不进入版本及其哈希，因此轮换密钥只需重启。消费者按服务商名称从当前 YAML 取密钥；若版本记录的地址不同，则拒绝发送密钥。不提供热更新。

提示词可在既有 JSON 字段内调整追问判断、措辞、报告侧重点和章节标题。输出字段、校验规则、任务状态和两阶段执行顺序由 Go 代码定义；调整这些内容需要修改代码并更新验收。配置不引入任意工作流。

每次访谈的追问和报告 release 均按[管理配置与访谈冻结](#management-settings-and-interview-freezing)保存。使用新的幂等键，可针对相同冻结答案和执行配置生成新编号报告，既有报告仍可查询。若要求新访谈版本一致，API 副本应使用相同启动配置。

### 报告校验

报告阶段在保存检查点前校验证据原文和引用。事实与任务卡必须引用已知证据 ID；证据为空时只允许 `needs_verification` 陈述，任务卡必须为空。`prompts.report.max_corrections` 为每阶段配置 0–3 次额外调用（默认 0，示例为 2），并冻结在发布版本中。纠错保留无效响应的调用审计，并向模型反馈失败字段路径。修改预算必须使用新的报告版本号。校验确保证据来源；语义是否受证据支持仍需审阅报告。参见[决策记录](../.agents/notes/implemented/feature/2026-10-14-worker-report-citations.zh.md)。

## API 与调用方职责

题目 `sourceRefs` 对象键在 MySQL 存储及会话恢复前后采用确定的序列化顺序，字段值和数组顺序仍有意义。必要时，请求与快照的历史摘要通过完整的已保存输入比较，保留旧记录并接受等价重试。参见[序列化决策](../.agents/notes/implemented/feature/2026-10-14-worker-reference-json.zh.md)。

| 请求 | 结果 |
|---|---|
| `POST /v1/tasks` | 接收 `followup` 或 `report` 请求，返回 HTTP 202 和已持久化任务。需要 `Content-Type: application/json` 及长度为 1–200 字符的 `Idempotency-Key`。 |
| `GET /v1/tasks/{id}` | 查询任务状态、尝试次数、错误码、版本及哈希、输出。 |
| `GET /v1/interviews/{id}/tasks` | 查询访谈任务和报告历史。 |

完整请求见 [examples/followup.json](examples/followup.json) 和 [examples/report.json](examples/report.json)。快照包含访谈 ID、正整数 `input_version` 和 `question_pack_version`、专家背景、带可选旧槽位的题目、答案及可选发布上下文。追问的目标答案必须已确认；报告要求每题都有已确认答案或已确认跳过。ID 使用 ASCII 字母、数字、下划线或连字符，最多 100 个字符。

```powershell
curl.exe http://127.0.0.1:3090/v1/tasks `
  -H "Authorization: Bearer <auth.token>" `
  -H "Content-Type: application/json" `
  -H "Idempotency-Key: interview-demo-followup-1" `
  --data-binary "@examples/followup.json"
```

任何快照内容变化都必须递增 `input_version`。旧版本及同版本不同内容返回 HTTP 409。过时追问标记为 `superseded`，不发布输出。请求键在数据库内全局唯一：网络重试使用同一个键；相同键对应不同内容返回 `IDEMPOTENCY_CONFLICT`。不同键提交的追问还按访谈、题目和输入版本去重。因此，同版本的终态失败追问会再次返回原任务，不会隐式创建新任务。

报告接收成功即冻结该访谈的答案，包括报告仍在排队或生成失败的情况。后续追问和更改快照返回 `INTERVIEW_FROZEN`。若需修改已冻结访谈，调用方必须创建新访谈 ID。本地草稿存储不触发入队，也不实现跨设备同步；后端必须提交快照并保存返回的任务 ID。

## 本地浏览器联调

在本目录运行，将本地配置的 `preview.enabled` 设为 `true`，保持 `server.listen: "127.0.0.1:3090"`，通过 `serve -c config.local.yaml` 或 [start-local.ps1](start-local.ps1) 启动。打开[本地访谈](http://127.0.0.1:3090/)。页面及问题包路径相对于进程工作目录。[examples/interview-pack.json](examples/interview-pack.json) 提供三道问题，每题声明模型判断的必需槽位。页面模型标识属于配置文本，不是服务商健康检查结果。

页面将已确认答案提交生成追问，支持补充回答或跳过，全部问题确认后生成报告。草稿使用浏览器本地存储。刷新会从 MySQL 恢复已接收快照及任务并继续轮询，在网络结果不确定时保留任务 ID 和幂等键。报告提交后冻结答案；重新生成产生基于相同答案的新报告版本。开始另一份访谈会创建新 ID，并保留原有数据库记录。

同源 `/browser` 网关通过签名 HttpOnly Cookie 限定访谈范围，拒绝跨源及非回环请求。后端共享令牌和模型密钥不下发浏览器。该入口用于本地调试；公开专家使用时仍需应用身份认证及授权。此入口未连接工作台发布流程。

## 执行与输出

任务从 `queued`、`running` 进入 `succeeded` 或 `failed`；过时追问进入 `superseded`。MySQL 保存队列并提供租约时钟。消费者通过 `FOR UPDATE SKIP LOCKED` 认领任务，续租，并在保存检查点或发布结果前校验认领令牌。消费者被终止后，其任务在租约到期后可重新执行。成功阶段保存检查点，重试可复用分析或提取的证据。

追问先判断 `complete`、`incomplete`、`uncertain` 或 `sensitive`，再至多生成一个问题。跳过项不调用模型。敏感答案、已发布轮次耗尽及模型暂时故障重试耗尽时，返回 `needs_review` 和 `allow_skip: true`。其他无效模型输出明确失败。网络故障、HTTP 408/429 和 5xx 按有上限的指数间隔重试；尝试次数包含首次执行。

报告先从答案逐字提取证据，再生成章节和任务卡。JSON Schema 拒绝不符合字段要求的结果；确定性校验拒绝无效分析、虚构引文，以及事实或任务卡缺失或未知的引用。槽位是可选旧输入，不是强制访谈清单。陈述区分 `fact`、`interpretation` 和 `needs_verification`。引用有效不代表陈述在逻辑上得到证据支持，仍需人工审阅。

数据库保留快照、提示词版本、阶段输出、模型请求及响应、报告，不记录请求头或密钥值。模型可见输入为配置的系统提示词及输出 schema 指令，之后是独立 JSON 用户消息。这种分离是指令约定，不保证抵御提示词注入。保留期/删除策略及公开限流仍由应用负责。模型调用中断且未保存检查点时可能重复调用并计费；队列令牌防止过时结果发布，不保证外部调用恰好一次。

## 服务器部署

[deploy/teaching-worker.service](deploy/teaching-worker.service) 使用不可登录的 `teaching-worker` 系统账号运行 Linux 程序，失败后重启，并读取 `/data/teaching-worker/config.yaml`。`/opt/teaching-worker/current` 指向带版本的发布目录。程序目录需允许服务账号遍历；配置目录保持 `0750 root:teaching-worker`，YAML 保持 `0640 root:teaching-worker`。Worker 的全部运行参数仍在这个 YAML 中。

[deploy/teaching-worker.locations.inc](deploy/teaching-worker.locations.inc) 应放在现有 HTTPS server 块内。`114.132.201.209` 的实际主机目录为 `/data/volume/nginx/conf.d`，容器名为 `nginx-compose`。模板将 `/teaching-worker/v1/` 代理到 `/v1/`，公开 `/teaching-worker/health`；该前缀下其他路径返回 404。Bearer 鉴权头透传给 Worker。前缀根路径重定向到健康检查。

模板上游为 `172.23.0.1:18083`，其中 IP 是 `nginx_default` 的宿主机网关；服务器 YAML 的 `server.listen` 设为相同地址，关闭 `preview.enabled`。MySQL 通过宿主机映射端口 `127.0.0.1:13306` 访问。网关、端口和路由属于部署选择，网络变化时需同步修改 YAML 和 Nginx 片段。共享该数据库的本地浏览器网关可使用 `mode: api`，服务器使用 `mode: both`。

```bash
systemctl status teaching-worker.service --no-pager
systemctl restart teaching-worker.service
journalctl -u teaching-worker.service -n 50 --no-pager
docker exec nginx-compose nginx -t
docker exec nginx-compose nginx -s reload
curl --fail https://114.132.201.209/teaching-worker/health
```

重载前必须检查 Nginx。保留上一个发布版本，并将受影响的 Nginx 配置备份在 `conf.d` 外，以便回滚。修改提示词或凭据需重启 Worker；修改路由需检查并重载 Nginx。

## 验证

```powershell
go test ./... -count=1
go test . -count=1 -args -mysql-config config.local.yaml
go vet ./...
go build -o teaching-worker.exe .
```

验收账号需要创建及删除临时数据库的权限。未提供 `-mysql-config` 时，进程验收明确跳过；该参数仅从指定 YAML 读取 `database.dsn`。测试创建独立临时数据库，编译实际可执行文件，分别启动 API 和消费者进程，覆盖租约恢复、旧结果拦截、消费者并发、幂等、阶段复用、提示词不可变、报告重生成和浏览器会话隔离。[testdata/flow.golden.json](testdata/flow.golden.json) 记录组装后的模型消息和输出。测试使用可控模型接口，不使用文件中的真实模型密钥；真实服务商兼容性及报告质量需要结合真实访谈和凭据单独验收。

## Portal 管理与访谈会话

远程 Linux 测试主机没有浏览器时，`-portal-browser-handoff <私有路径>` 写出合成测试的浏览器来源地址和题包路径，等待最多 120 秒，读取 `<私有路径>.done` 中的 `PASS` 结果。通过 SSH 回环隧道向该隔离地址运行 [tests/portal-browser.mjs](tests/portal-browser.mjs) 后返回结果；该选项不连接真实模型接口。

通过已配置的 DSH Host 自动生成题包时，参见[题包 CLI](../docs/teaching-pack-cli.zh.md)。`import-pack --dry-run` 按显式目录和大小限制校验发布文件，不加载服务配置或连接 MySQL；移除 `--dry-run` 后，复用管理员上传的原子发布机制，不覆盖已有题包。使用独立工具及现有目录权限执行，无须替换或重启服务。

显式设置 portal.enabled，并配置既有 packs_dir、公开 origin、会话及上传限制和登录速率限制。非回环地址要求 HTTPS。通过 /admin/ 登录、上传/列举/移除 JSON 题包、查看报告和下载报告 JSON；报告列表最多显示最近 200 个任务。账号从 MySQL 读取；首次初始化只有在提供有效 admin_password_hash 时才插入用户名 admin。Portal 启动拒绝示例后端令牌占位值。既有密码不被覆盖，不强制首次改密。受访者不需要注册，也没有通用 RBAC 系统。

hash-password --output <新建私有文件> 从标准输入读取密码，以随机盐和 600,000 次 PBKDF2-HMAC-SHA256 写入仅文件所有者可读的新文件，不打印密码或哈希，不覆盖文件。实际输入或持久保存真实凭据需另外授权，没有默认密码；成本遵循 [OWASP 密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。仅将获准的哈希复制到私有启动配置，不写入受 Git 跟踪的文件。

受访者路由只有在明确开启 participants_enabled 并填写 entry_mode（link/list）、invitation_mode（code/none）、participant_reports（allow/deny）、资产、轮询及模型标识后才启用。这些是可选择的协议选项，不代表用户批准默认产品策略。管理与访谈使用不同的 HttpOnly、SameSite=Strict Cookie，服务端校验有效期，变更请求校验准确来源。管理退出撤销数据库会话；login_limit 和 login_window 配置各进程登录预算。

根路径 / 与既有 /practice-expert-interview-spa.html 使用原母版并选择 worker 入口；/portal/api 负责受访者请求，不存在的 API/JSON 返回错误而非 HTML。link 模式不公开题包列表。链接可将不可变上传键作为 fieldnoteId；多版本别名要求明确版本键，不自动选择最新文件。code 模式使用 Worker 自有访问记录校验提交的口令，并只读兼容既有题包口令；参与者 API 不返回已保存口令。明确分享的口令片段会从浏览器历史中移除，只预填进入表单，不自动提交。上传文件保持为私有发布对象，受访者视图排除邀请信息与主持人资料。

[DSH 工作台](../packages/client/ui-polus-teaching-reform/README.zh.md#publish-and-share)发布不可变 JSON，包含题目设计来源和逐题文字输入策略。`interviewPolicy` 选择 `per_question` 或 `interview`，新访谈上限为 0–2；零禁用追问。发布文件缺少策略时采用每题两次。仅实际符合条件的文字输入调用模型：纯选择题绕过模型，条件“其他”须同时选中并填写文字。来源摘录描述问题设计，不作为受访者事实证据。

上传先解析和限制大小，再进行同文件系统原子发布，禁止覆盖。相同键相同内容重试成功，不同内容使用新键。拒绝路径形式的键、越界符号链接、非法正式文件和未完成上传。会话在 MySQL 保存题包副本、版本、私有完整哈希及策略，目录删除或替换不改变活跃会话；浏览器绑定哈希排除邀请信息，避免暴露短口令的快速摘要。

回答复用事务快照与任务幂等，追问次数在调用模型前和访谈最终锁内检查。模型上下文包含目标、背景、可选提示、真实回答历史及已有追问，可以判断回答充分而不再生成问题；提示和回答仍是用户数据。报告复用逐字证据及引用校验。participant_reports 为 deny 时不向受访者输出报告正文，管理 API 始终要求登录。进程重启恢复已接收快照、任务和报告；未发送草稿仍在浏览器。

执行 go test . -args -mysql-config <隔离配置> -portal-browser 可通过 tests/portal-browser.mjs 使用已安装的 Playwright/Chromium 检查真实 portal；单独安装的浏览器通过 PORTAL_TEST_CHROMIUM 指定。浏览器检查登录/上传、邀请、单选、可控语音入口、本地草稿刷新、真实 HTTP 回答提交、带证据的报告下载和退出。模型接口与语音识别为测试替身，不证明真实模型质量或麦克风可用。

### 已保存报告的网页预览与 PDF

管理端和参与者使用相同的 HTML 报告排版，保留陈述类型、任务卡字段及原文证据锚点。下载内容是真正的可选择文字 PDF，JSON 保留为内部 API 表示。排队和失败报告显示状态，不提供导出按钮。

| 读取方 | 需要认证的 GET 路由 |
|---|---|
| 管理员 | `/admin/api/reports/{id}/view` 和 `/admin/api/reports/{id}/pdf`，使用现有管理会话 |
| 参与者 | `/portal/api/tasks/{id}/view` 和 `/portal/api/tasks/{id}/pdf`，使用对应访谈会话并要求 `participant_reports: allow` |
| 回环预览 | `/browser/tasks/{id}/view` 和 `/browser/tasks/{id}/pdf`，使用签名预览会话 |
| 可信后端 | `/v1/tasks/{id}/view` 和 `/v1/tasks/{id}/pdf`，使用现有后端 Bearer 令牌 |

匿名读取返回 401，访问其他参与者的报告返回 404，参与者可见性拒绝返回 403，未完成或失败报告返回 409。渲染校验已保存的报告和证据，转义 HTML，响应设置为私有且不缓存；不更新报告或调用模型。PDF 嵌入[已授权中文字体](internal/reportview/fonts/README.zh.md)，长文按 A4 分页换行，包含证据链接和页码。不支持的字形导致渲染失败，避免静默丢字；HTML 保留原文。

生产环境只需编译后的 Worker、原有两个 SPA 资源文件以及随附的[许可声明](licenses/README.zh.md)。字体和报告 HTML 已嵌入，不需要浏览器、Python、外部 PDF 服务或新增配置。PDF 渲染本身不改变结构或报告历史版本；应用回退需遵守[结构迁移与回退](#schema-migration-and-rollback)。

`TestReportPreviewAcceptance` 在 API-only 模式下创建临时数据库，直接保存合成报告而不调用模型。`-report-browser-handoff <私有路径>` 通过 SSH 回环隧道执行[真实浏览器检查](tests/report-preview.browser.mjs)，在 150 秒内用 `.done` 文件返回 `PASS`。交接文件仅包含合成测试会话凭据，必须保留在 Git 外。独立 PDF 检查校验中文全文完整性、字体嵌入、页面边界及证据跳转目标。

<a id="management-settings-and-interview-freezing"></a>

### 管理配置与访谈冻结

`GET`/`PUT /admin/api/settings` 管理全局业务提示词；`GET`/`PUT /admin/api/packs/{key}/settings` 管理题包覆盖和策略。沿用既有管理会话及精确 origin 写入检查。更新需携带当前 `revision`、题包 `publication_hash` 和 `settings`；修订冲突返回 409。可编辑字段为追问、报告的 `analyze` 和 `compose` 业务文本，以及题包 `policy`。模型及服务字段会被拒绝，Go 中的输出 schema 和引用校验始终执行。

不启用覆盖时，业务提示词按 YAML → 全局 → 题包继承。题包策略继承不可变发布文件的策略，除非明确覆盖。相同发布重试保留设置，新版本具有独立覆盖。删除题包后用不同字节替换相同键，不会静默重绑定已有设置。

参与者进入时，将两类 pipeline release、公开服务与模型配置、执行预算和有效策略冻结到 `tw_interview_runtime`；仅使用后端 API 的访谈在首次提交时冻结。后续任务、重试和报告版本在重启后仍沿用该记录。凭据保留在运行中的 YAML。并发数和轮询仍属于进程配置。管理端修改仅影响新访谈；上传不修改设置或进行中的访谈。

旧访谈保留已保存的追问 release 和最早记录的报告 release。若没有历史报告 release，首次恢复任务捕获服务启动时的报告基线，忽略新的管理端提示词覆盖。从未记录过的历史配置无法重建。旧参与者策略保留在其发布副本中；新建会话时解析当前设置。

旧发布桥绑定准确的回环 opener origin、窗口和 nonce；受认证上传仅返回对应回执与参与者分享地址，凭据留在 Worker。缺少策略与参与者入口使用相同内置默认值。当前桌面发布使用下文的上传 Key 代理。管理页框架限制和准确来源校验继续生效。


### Worker 自有参与者口令

新客户端不在发布 JSON 中生成口令。经过认证的新题包上传在 `tw_pack_access` 中生成密码学安全随机的六位数字口令，保留前导零，并发及同版本重试复用唯一记录。既有数据库和题包口令（包括长口令）只读兼容，不回填、不替换、不自动轮换；重试不会重新启用已撤销口令。参与者校验读取权威访问状态，口令轮换或撤销不终止已生效的参与者 Cookie。[六位口令决策](../.agents/notes/implemented/feature/2026-10-19-six-digit-worker-invitations.zh.md)说明共享内存尝试限制及其防护缺口。

`GET /admin/api/packs/{key}/access` 仅向已认证管理员返回当前口令及片段分享地址，设置 `Cache-Control: no-store`。同路径 `POST` 接受明确的 `create`、`rotate` 或 `revoke` 操作，以及当前修订号和题包哈希；过时写入返回 409。为允许授权管理员和重试读取，口令在现有 MySQL 权限保护下可恢复保存，数据库备份和客户端数据应按凭据保护。不增加管理员凭据、加密主密钥或公开口令接口；不得记录口令或将其放入查询参数。

管理菜单将题包管理、访谈报告、API Key 和系统设置分开。`/admin/?configure={key}` 在当前题包内打开设置；`/admin/?view=reports` 管理报告，`/admin/?view=settings` 管理全局提示词。菜单选中态、刷新和浏览器返回保持当前页面。新客户端在传输前要求 Worker 支持服务端口令；旧客户端仍可发布旧载荷并保留原口令。

### 发布 API Key

管理员在 `/admin/?view=publisher-keys` 创建命名 Key，可选择有效期。完整值只在创建成功时返回一次；列表仅返回前缀、状态、创建/最近使用时间与有效期，最多最近 200 项。遗失后应撤销并新建，不提供找回。`GET/POST /admin/api/publisher-keys` 与 `DELETE /admin/api/publisher-keys/{id}` 使用现有管理员会话和同源写入校验，响应禁止缓存。

发布 Key 只授权 `POST /publish/api/packs/{key}` 上传不可变题包并返回本次对应回执，不授权管理、报告、设置或模型后端 API。请求只接受 Authorization Bearer；哈希保存在 MySQL，完整 Key 不写入数据库或日志。撤销和授权通过行锁串行化，已获授权的在途请求可以完成；过期按数据库 UTC 时间判断。参与者口令独立管理，其兼容行为保持不变。

HTTPS 服务必须包含[发布接口反代片段](deploy/teaching-worker.publisher.locations.inc)，并与 Worker 上传大小限制匹配。部署前检查现有路由，执行 Nginx 配置验证后才重载；候选包不自动应用配置或创建生产 Key。桌面端使用系统加密保存此 Key，按[桌面说明](../apps/desktop/README.zh.md)配置。

<a id="schema-migration-and-rollback"></a>
### 结构迁移与回退

结构版本 5 增加空的 `tw_publisher_keys`，不生成或补写凭据。版本 4 的 `tw_pack_access` 与版本 3 的运行设置、访谈冻结及所有业务行和题包文件保留。版本 1–4 仅在 `database.auto_migrate` 开启时升级；旧版本 4 二进制拒绝结构 5。

经批准部署前应共同备份数据库、私有配置与题包，并在隔离环境验证完整恢复。[维护工具](deploy/access-maint/README.zh.md)只允许在所有写入者停止、原表/文件指纹不变且新增表为空时恢复对应结构 3/4 的完整快照。创建 Key、使用或撤销 Key、口令变化或任何业务写入都会使旧备份失效，禁止手工降低版本号。已有新写入时保留结构 5，使用兼容修复或 UI 回退。UI 回退包含当前结构 5 后端和指定旧页面，保留已保存的访问口令、报告和原生 Key 上传接口；旧页面不能创建/撤销 Key，应恢复当前页面后再管理授权。此方式不能修复任意后端故障。

## 回答模式

发布解析继续严格校验旧 `text`、`choice`、`mixed`、`other` 模式及输入策略。专家渲染始终显示叙述输入框，过滤“其他/请补充”和“不适用/暂不适用/暂不使用”等兜底控件，不重新编号选项或丢弃历史选择。含相关词的实质业务选项与题干保持完整。Worker 允许旧题独立于选项提交叙述文字；固定追问上限继续有效。更新 Worker 可执行程序与 HTML/JS 资源并刷新页面后，现有发布和恢复中的访谈直接修复，无需重新发布或迁移数据库。新的生成、编辑和本地预览需要更新客户端。参见[叙述输入](../.agents/notes/implemented/bug-fix/2026-10-20-always-visible-expert-input.zh.md)。
