# Quittr Dashboard

这是一个本地运行的 Quittr 恢复进度 Dashboard 原型，用于展示戒断进度、打卡承诺、统计分析、资料库、个人页和 Melius 聊天界面。

## 技术栈

- 前端：原生 HTML/CSS/JS + React 18 UMD
- 后端：原生 Node.js `http` 服务
- 数据存储：本地 JSON 文件

## 本地启动

### 1. 启动服务

```bash
npm start
```

### 2. 打开页面

```text
http://localhost:3000
```

项目没有 npm 运行时依赖，`package.json` 目前只定义了 `npm start`。

## 当前功能

- 首页恢复进度、里程碑、快捷操作和功能卡片
- Pledge 弹窗与完成动画
- Analytics 页面，展示当前 streak、历史 reset、趋势图和统计指标
- Reset 按钮会写入一次 relapse 记录，并刷新统计数据
- Library 页面，包含声音场景、课程、游戏和排行榜原型
- Profile 页面，展示徽章、成就和帖子原型
- Melius 聊天页，目前只保留本地临时消息，不保存历史
- 底部导航，可在 Home、Chat、Stats、Library 和 Profile 之间切换

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | Quittr Dashboard 页面 |
| `GET` | `/api/quittr/analytics` | 获取恢复统计数据 |
| `POST` | `/api/quittr/relapses` | 记录一次 relapse/reset 并返回新统计 |

## 本地数据

```text
.
├── data/
│   └── quittr-state.json
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── server.js
└── package.json
```

- `data/quittr-state.json` 保存 Quittr 的开始时间和 relapse 记录。
- 如果数据文件不存在，服务端会自动创建一份默认状态。
- Melius 聊天消息只保存在当前浏览器会话中，刷新页面后会清空。

## 注意事项

- 推荐使用 Node.js 18 或更高版本。
- 页面通过 CDN 加载 React 18，浏览器需要能访问 `unpkg.com`。
- 当前没有自动化测试脚本。

## License

License information has not been specified yet.
