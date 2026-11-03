# 视频转写问答 Web 应用

本项目是一个仅供本机使用的 Web 小工具：输入视频链接（B 站、YouTube、抖音等），优先下载音频，调用阿里云百炼 `qwen-audio-3.1-asr-flash` 将口播转成文字，并支持基于生成文稿继续提问。

## 功能特性

- **多平台支持**：自动识别 B 站、YouTube、抖音、小红书、Twitter 等平台，按平台适配下载参数
- **按转写需求下载**：优先下载约 64kbps 的独立音轨，原生 DASH/HLS 分片默认 4 路并发，减少下载体积和等待时间
- **合集批量转写**：粘贴合集/播放列表链接自动识别，逐个视频批量转写并实时显示每个视频进度
- **音频优先识别**：只下载独立音轨，按 120 秒切段发送到 `qwen-audio-3.1-asr-flash`；无独立音轨时回退到含声音的视频。不把画面字幕当作口播，不包含视觉内容识别
- **断点续传**：中断后重新提交同一链接，自动从断点继续
- **文稿下载**：转写完成后可一键下载 txt 文件，文件名格式为 `标题-博主名-平台.txt`
- **文稿问答**：基于生成的文稿内容向模型提问

## 技术栈

- 前端：原生 HTML / CSS / JS（零依赖）
- 后端：原生 Node.js `http` 服务（零 npm 依赖）
- 视频下载：`yt-dlp`
- 视频处理：`ffmpeg` / `ffprobe`
- 语音转写：阿里云百炼通用 API `qwen-audio-3.1-asr-flash`（原生 HTTP 接口，独立配置 Key 与地址）
- 文稿问答：阿里云百炼 Coding Plan `qwen3.7-plus`

## 本地启动

1. 复制环境变量文件：

```bash
cp .env.example .env
```

2. 编辑 `.env`，填入：

```env
DASHSCOPE_API_KEY=你的百炼 API Key
DASHSCOPE_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
ASR_API_KEY=你的百炼通用APIKey
ASR_BASE_URL=https://你的工作空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
ASR_MODEL=qwen-audio-3.1-asr-flash
DASHSCOPE_CHAT_MODEL=qwen3.7-plus
PORT=3002
# 可选：全局 yt-dlp 额外参数（如代理），各平台参数已自动适配
YTDLP_EXTRA_ARGS=
```

3. 安装系统依赖：

```bash
brew install yt-dlp ffmpeg
```

4. 启动服务：

```bash
npm start
```

5. 打开浏览器访问 `http://localhost:3002`

## 使用方式

1. 在页面输入视频链接（支持 B 站、YouTube、抖音等平台）。
2. 点击"提取并转写"。
3. 等待视频分段识别完成，文稿会实时显示在页面上，同时写入 `jobs/<hash>/transcript.txt`。
4. 转写完成后，点击"下载文稿"按钮可下载 txt 文件（文件名为 `标题-博主名-平台.txt`）。
5. 在"文稿问答"里输入问题，应用会基于当前文稿回答。

## 合集批量转写

直接在同一个输入框粘贴合集或播放列表链接即可，应用会自动判断：

- **单个视频** → 走常规单视频流程
- **合集 / 播放列表** → 自动解析所有视频，逐个转写

支持的合集链接示例：

| 平台 | 合集链接 |
|---|---|
| B 站 | 合集页 `collectiondetail?sid=xxx`、多 P 视频 |
| YouTube | 播放列表 `youtube.com/playlist?list=xxx` |

处理时页面会出现"合集进度"面板：

- 顶部显示总进度条与 `已完成/总数`
- 下方列出每个视频，实时更新状态（等待中 → 处理中 → 已完成 / 失败）
- 每个视频单独保存到自己的 `jobs/<hash>/` 目录，可分别下载文稿
- 单个视频失败不会中断整个合集，会自动继续下一个
- 重新提交同一合集会跳过已完成的视频（断点续传）

对应的 API：

- `POST /api/playlist-check`：探测链接是否为合集，返回 `{ isPlaylist, count, entries }`
- `POST /api/transcribe-batch`：批量转写合集，NDJSON 流式推送每个视频的进度事件

## 音频识别与分段策略

ASR 使用独立的 `ASR_API_KEY`、`ASR_BASE_URL` 和 `ASR_MODEL`，默认最新的短音频模型 `qwen-audio-3.1-asr-flash`（2026-11-03 核对）。请从百炼控制台复制同一地域、同一业务空间的通用 Key 和 Base URL，不能混用 Coding Plan Key。ASR 调用独立按量计费。

该模型使用百炼原生接口，应用自动将配置的 OpenAI 兼容地址转换为同一域名下的 `/api/v1/services/aigc/multimodal-generation/generation`，不会向问答模型的地址发送语音识别请求。音频以 `input_audio` Base64 Data URI 发送，读取 `output.text`，不需要 OSS。默认不启用转写润色，以保留口播；分段结果不会保证跨段说话人身份一致。

流程：下载独立音轨 → 转为 MP3（16kHz / 单声道 / 32kbps）→ 每 120 秒切段 → ASR → 保存逐字稿 → 主题整理与问答。分段完成数、停止、重试和断点保存均适用于音频流程。已有完整源视频或规范化视频会直接提取音频，避免重复下载。

### 转写并发（决定你等多久）

ASR 是托管接口，墙钟时间主要花在**每个请求的往返延迟**上，而不是本机 CPU。48 分钟视频切成 24 段，串行提交就是 24 次约 55 秒的排队，合计约 22 分钟——这就是"转写要一半时长"的来源。

现在改为**有界并发池**，默认 4 路：

```env
ASR_CONCURRENCY=4   # 有效范围 1–8
```

- 48 分钟视频：约 22 分钟 → **6～7 分钟**（不含下载）
- 并发上限受 `qwen-audio-3.1-asr-flash` 的 600 RPM 约束，4–6 路是安全带
- 每段结果按 `results/chunk-xxx.txt` 单独落盘，并发写入互不影响；文稿与检查点是同步写，不会交错
- 停止时已完成的段全部保留，再次提交从断点继续
- 网络不稳时可降到 1–2，避免大量重试反而更慢

尚未做的进一步优化：**边下边转**（下载与转写流水线重叠，可再省 1–3 分钟）、静音段跳过（省 10–20% 调用，但会影响时间轴对齐）。

旧视觉模型不支持理解视频音轨，因此从旧模型切换时，已有分段和文稿会移到任务目录的 `previous-transcription-<时间戳>/` 中备份，再以真实音频重做识别；源视频保留。同一 ASR 模型的任务仍可从已完成分段继续。

官方文档：[模型说明](https://help.aliyun.cn/zh/model-studio/qwen-audio-3-1-asr-flash)、[原生 HTTP API](https://help.aliyun.com/en/model-studio/qwen-audio-asr-http-api)。

## 断点续传

- 每个视频链接对应一个 `jobs/<hash>/` 目录，保存 `source.*`、`audio.mp3`、`transcript.txt`、`checkpoint.json` 等。
- 每个视频 chunk 完成后立即写入 `results/chunk-xxx.txt`，再重建 `transcript.txt`。
- 中途失败后，重新提交同一链接会跳过已完成 chunk，从断点继续。
- `checkpoint.json` 记录当前阶段、总段数、已完成段数、当前 chunk 和最近错误。
- 每个音频片段最多尝试 3 次。

## 多平台与下载排查

### 下载速度优化

旧版默认选择最高画质，再压缩到 640px 宽，长视频可能先下载数 GB 的 4K 视频。现在主流程只下载音轨，音频优先约 64kbps。平台没有独立音轨时，选择低分辨率的音画合一流后提取声音。视频下载工具仍保留 480p 优先策略供后续画面扩展使用，当前 ASR 不使用画面。

原生 DASH/HLS 分片默认 4 路并发；普通 HTTPS 整文件下载不受此并发参数影响。分片耗尽重试后会报错，避免跳过分片造成文稿缺失。网络下载和分片各重试 3 次、提取重试 2 次，单次连接超时 15 秒；YouTube 下载残缺时直接切换到无 Cookies 的 DASH 提取方式，避免重复下载同一残缺流。标题和作者会随下载保存，后续处理优先复用，减少重复提取请求。

可在 `.env` 中调整（桌面版配置目录可从应用菜单打开）：

```env
# 默认 480，可设为 720 以保留更多画面细节；有效范围 144–2160
YTDLP_MAX_HEIGHT=480
# 默认 4，有效范围 1–16；网络不稳定时可降至 2 或 1
YTDLP_CONCURRENT_FRAGMENTS=4
```

配置在服务或桌面应用重新启动后生效。`YTDLP_EXTRA_ARGS` 仍可覆盖默认并发、超时等参数。画质降低会减少下载量，但实际速度也受代理带宽、平台限速和连接质量影响；现有完整下载仍可复用。

这些选项的作用和限制见 [yt-dlp 官方下载参数](https://github.com/yt-dlp/yt-dlp#download-options)与[格式排序说明](https://github.com/yt-dlp/yt-dlp#sorting-formats)。

### 平台与代理

系统会根据 URL 自动检测平台并应用对应参数：

| 平台 | 自动参数 |
|---|---|
| B 站 | `--cookies-from-browser chrome --referer https://www.bilibili.com/` |
| YouTube | `--cookies-from-browser chrome` |
| 抖音 / TikTok | `--cookies-from-browser chrome` |
| 其他 | `--cookies-from-browser chrome` |

`YTDLP_EXTRA_ARGS` 中的参数会追加到所有平台，适合配置代理：

```env
YTDLP_EXTRA_ARGS="--proxy http://127.0.0.1:7890"
```

常用选项：

- `--proxy http://127.0.0.1:7890`：走本机代理（YouTube 等需要翻墙的网站必备）。
- `--cookies-from-browser chrome`：读取 Chrome 登录态。
- `--cookies cookies.txt`：使用导出的 Netscape cookies 文件。

## 重要说明

- API Key 只在本地服务端使用，不会暴露到前端。
- YouTube 等需要代理的网站，请确保本机终端可以访问，或在 `YTDLP_EXTRA_ARGS` 中配置代理。
- 文稿问答只基于 `transcript.txt` 回答；如果转写有遗漏，问答也会受影响。
