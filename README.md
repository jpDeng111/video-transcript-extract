# B 站音频转写问答 Web 应用

本项目是一个仅供本机使用的 Web 小工具：输入 Bilibili 视频链接，自动提取音频，调用阿里云百炼 Coding Plan 的 `qwen3.7-plus` 原生多模态模型转成文字，并支持基于生成文稿继续提问。

## 当前方案

- 前端：原生 HTML/CSS/JS
- 后端：原生 Node.js `http` 服务
- 音频提取：`yt-dlp`
- 音频处理：`ffmpeg` / `ffprobe`
- 音频转写：阿里云百炼 Coding Plan `qwen3.7-plus`
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
YTDLP_EXTRA_ARGS=
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

## 使用方式

1. 在页面输入 B 站视频链接。
2. 点击“提取并转写”。
3. 等待音频分段识别完成，文稿会实时写入 `jobs/<hash>/transcript.txt`。
4. 转写完成后，在“文稿问答”里输入问题，应用会基于当前文稿回答。

## 断点续处理

- 每个视频链接会对应一个 `jobs/<hash>/` 目录，里面保存 `audio.mp3`、`transcript.txt`、`checkpoint.json`、分段音频和每段结果。
- 处理长视频时，每个音频 chunk 完成后会立刻写入 `results/chunk-xxx.txt`，再重建 `transcript.txt`。
- 如果中途失败，再次提交同一个链接会跳过已完成 chunk，从断点继续。
- `checkpoint.json` 会记录当前阶段、总 chunk 数、已完成 chunk 数、当前正在处理的 chunk 和最近错误。
- `chunks-manifest.json` 用来确认分片是否完整；如果切分阶段中断，下次会重新切分音频，但不会删除已经完成的 `results/chunk-xxx.txt`。
- 页面上的“读取本地进度”会读取 `checkpoint.json`、`chunks-manifest.json` 和 `results/`，显示已完成段数和下次继续的片段。
- 每个音频片段会自动重试 3 次；如果网络或接口失败，已经写入的片段会保留在本地。

## 音频分段策略

后端会先把音频规范化为 16kHz、单声道、32kbps MP3，再按 240 秒切段，然后把每段音频发给 `qwen3.7-plus` 原生多模态模型做逐段转写。

5 小时视频约为 75 个 240 秒片段。只要磁盘空间足够，应用会按片段持续处理；浏览器断开、网络失败或模型请求失败后，重新提交同一个链接即可从第一个未完成片段继续。

## B 站下载排查

后端下载时会自动尝试普通下载、IPv4、legacy TLS 和跳过证书校验。如果遇到 `HTTP 412 Precondition Failed`，通常是 B 站拒绝了未登录或缺少浏览器状态的请求，需要带上你本人浏览器里的 B 站登录 cookies。

可以在 `.env` 中添加额外 `yt-dlp` 参数：

```env
YTDLP_EXTRA_ARGS="--no-update --cookies-from-browser chrome --user-agent Mozilla/5.0 --referer https://www.bilibili.com/ --add-headers Accept-Language:zh-CN,zh;q=0.9,en;q=0.8"
```

常用选项：

- `--proxy http://127.0.0.1:7890`：让终端里的 `yt-dlp` 走本机代理。
- `--cookies-from-browser chrome`：读取 Chrome 登录态，适合需要登录或风控的视频。
- `--cookies cookies.txt`：使用导出的 Netscape cookies 文件。

如果 `--cookies-from-browser chrome` 因为系统钥匙串或浏览器权限读取失败，可以导出 Netscape 格式 `cookies.txt` 放到项目根目录，然后改成：

```env
YTDLP_EXTRA_ARGS="--no-update --cookies cookies.txt --user-agent Mozilla/5.0 --referer https://www.bilibili.com/ --add-headers Accept-Language:zh-CN,zh;q=0.9,en;q=0.8"
```

## 重要说明

- 你的 API Key 只在本地服务端使用，不会暴露到前端页面。
- 如果 Bilibili 访问依赖 VPN 或代理，请确保本机终端环境也能正常访问。
- 文稿问答只会基于 `transcript.txt` 回答；如果转写遗漏，问答也会受影响。
