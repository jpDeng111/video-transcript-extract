# 视频内容提取 Web 应用

本项目是一个仅供本机使用的 Web 小工具：输入 YouTube、Bilibili 等视频链接，自动下载视频并调用阿里云百炼 `qwen3.6-plus` 提取其中的口播、对白、旁白与字幕内容，整理成可复制文本。

## 当前方案

- 前端：原生 HTML/CSS/JS
- 后端：原生 Node.js `http` 服务
- 视频下载：`yt-dlp`
- 视频处理：`ffmpeg` / `ffprobe`
- 视频理解：阿里云百炼 `qwen3.6-plus`

## 本地启动

1. 复制环境变量文件：

```bash
cp .env.example .env
```

2. 编辑 `.env`，填入：

```env
DASHSCOPE_API_KEY=你的百炼 API Key
DASHSCOPE_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
PORT=3000
```

3. 安装依赖工具：

- `yt-dlp`
- `ffmpeg`（需包含 `ffprobe`）

如果你用 Homebrew，可执行：

```bash
brew install yt-dlp ffmpeg
```

4. 启动服务：

```bash
npm start
```

5. 打开浏览器访问：

```text
http://localhost:3000
```

## 说明

- 项目默认会把长视频切成 4 分钟一段，逐段发送给模型后拼接结果。
- 每个视频链接会对应一个 `jobs/<hash>/` 目录，里面保存 `transcript.txt`、`checkpoint.json`、分段视频和每段结果。
- 处理长视频时，每个 chunk 完成后会立刻写入 `transcript.txt`；如果中途失败，再次提交同一个链接会跳过已完成 chunk，从断点继续。
- `results/chunk-xxx.txt` 是最重要的断点数据：只有某段模型返回成功后才会写入该文件。
- `checkpoint.json` 会记录当前阶段、总 chunk 数、已完成 chunk 数、当前正在处理的 chunk 和最近错误。
- `chunks-manifest.json` 用来确认分片是否完整；如果切分阶段中断，下次会重新切分视频，但不会删除已经完成的 `results/chunk-xxx.txt`。
- `transcript.txt` 每次由已完成的 chunk 重新拼接并原子写入，因此即使浏览器断开，也能保留已经完成的文字。
- 你的 API Key 只在本地服务端使用，不会暴露到前端页面。
- 如果你使用的是百炼 `Coding Plan` 专属 Key，网关应使用 `https://coding.dashscope.aliyuncs.com/v1`。
- 如果 YouTube 访问依赖 VPN，请先确保本机终端环境也能正常访问。
- 这不是专门的 ASR 语音识别方案，而是基于视频理解模型尽量还原视频中的文字内容，准确率会受画面、字幕、口播清晰度影响。

## 重要说明

由于你当前的 Key 只能使用 `qwen3.6-plus`，本项目实现改为“视频输入理解”方案，而不是专门的音频 ASR 方案。
# quittr-copy
