# 视频转写问答 Web 应用

本项目是一个仅供本机使用的 Web 小工具：输入视频链接（B 站、YouTube、抖音等），自动下载并压缩视频，调用阿里云百炼 Coding Plan 的 `qwen3.7-plus` 多模态模型将视频内容转成文字，并支持基于生成文稿继续提问。

## 功能特性

- **多平台支持**：自动识别 B 站、YouTube、抖音、小红书、Twitter 等平台，按平台适配下载参数
- **视频直传模型**：将视频以 `video_url` 格式直接输入 `qwen3.7-plus`，同时利用画面和音频信息
- **断点续传**：中断后重新提交同一链接，自动从断点继续
- **文稿下载**：转写完成后可一键下载 txt 文件，文件名格式为 `标题-博主名-平台.txt`
- **文稿问答**：基于生成的文稿内容向模型提问

## 技术栈

- 前端：原生 HTML / CSS / JS（零依赖）
- 后端：原生 Node.js `http` 服务（零 npm 依赖）
- 视频下载：`yt-dlp`
- 视频处理：`ffmpeg` / `ffprobe`
- 视频转写：阿里云百炼 Coding Plan `qwen3.7-plus`
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
DASHSCOPE_ASR_MODEL=qwen3.7-plus
DASHSCOPE_CHAT_MODEL=qwen3.7-plus
PORT=3000
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

5. 打开浏览器访问 `http://localhost:3000`

## 使用方式

1. 在页面输入视频链接（支持 B 站、YouTube、抖音等平台）。
2. 点击"提取并转写"。
3. 等待视频分段识别完成，文稿会实时显示在页面上，同时写入 `jobs/<hash>/transcript.txt`。
4. 转写完成后，点击"下载文稿"按钮可下载 txt 文件（文件名为 `标题-博主名-平台.txt`）。
5. 在"文稿问答"里输入问题，应用会基于当前文稿回答。

## 视频分段策略

后端会先把视频压缩为 640px、CRF 36、音频 32kbps 单声道，再按 120 秒切段。每段视频以 base64 编码通过 `video_url` 格式发给 `qwen3.7-plus`。

| 参数 | 值 | 说明 |
|---|---|---|
| 分辨率 | 640px 宽 | 在保证可识别的前提下尽量缩小 |
| CRF | 36 | 较高压缩比 |
| 码率上限 | 800k | 防止突发高码率 |
| 音频 | 32kbps / 16kHz / 单声道 | 语音识别足够 |
| 分段 | 120 秒 | 保证 base64 后不超过 API 28MB 限制 |

## 断点续传

- 每个视频链接对应一个 `jobs/<hash>/` 目录，保存 `source.mp4`、`normalized.mp4`、`transcript.txt`、`checkpoint.json` 等。
- 每个视频 chunk 完成后立即写入 `results/chunk-xxx.txt`，再重建 `transcript.txt`。
- 中途失败后，重新提交同一链接会跳过已完成 chunk，从断点继续。
- `checkpoint.json` 记录当前阶段、总段数、已完成段数、当前 chunk 和最近错误。
- 每个视频片段最多自动重试 3 次。

## 多平台与下载排查

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
