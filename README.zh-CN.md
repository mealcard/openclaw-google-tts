# google-tts

中文说明。English: [README.md](./README.md)

`google-tts` 是一个 OpenClaw 插件，提供：

- Gemini TTS
- Google Cloud Text-to-Speech
- Telegram 语音气泡自动回复

它支持手动 `/gtts` 合成，也支持聊天级别的 `/voice` 模式。开启后，每次回复会发送：

- 一条普通文字消息
- 一条 Telegram 语音气泡

自动语音链路完全在插件内部实现，不依赖修改 OpenClaw core。

许可证：MIT。见 [LICENSE](./LICENSE)。

## 只对指定 agent/bot 生效

这个插件的设计目标是“只对指定的 agent 或 bot 账号生效”。

控制方式在 `voice-config.json`：

- `autoVoiceAccounts` 决定哪些 bot 账号可以使用 `/voice`
- `accounts.<accountId>` 可以为每个 bot 单独设置默认 voice 和 style

如果某个 bot 账号不在白名单里，这个 bot 就不会启用自动语音命令。

## 哪些内容适合公开发布

这个目录已经整理成适合发 GitHub 的版本，故意没有包含这些运行时文件：

- `google-tts-tokens.json`
- `voice-state.json`
- `out/`

这些文件可能包含凭证、会话状态或已生成的音频，不适合公开。

## 环境要求

- OpenClaw `2026.3.x` 或更高
- 系统里有 `ffmpeg`
- 如果要用 Telegram 语音气泡，需要先在 OpenClaw 里配置 Telegram bot
- 认证方式二选一：
  - Gemini TTS 使用 `GOOGLE_API_KEY`
  - Google Cloud TTS 使用 OAuth token

## 安装

克隆仓库后，进入插件目录执行：

```bash
openclaw plugins install -l .
openclaw plugins doctor
openclaw gateway --force
```

如果你不想用 link 模式，也可以用复制安装：

```bash
openclaw plugins install .
openclaw plugins doctor
openclaw gateway --force
```

## 配置

1. 先复制示例配置：

```bash
cp voice-config.example.json voice-config.json
```

2. 再编辑 `voice-config.json`。

最小示例：

```json
{
  "autoVoiceAccounts": ["your-bot-account-id"],
  "autoVoiceModel": "gemini-2.5-flash-preview-tts",
  "accounts": {
    "your-bot-account-id": {
      "defaultVoice": "Leda",
      "defaultStyle": "请用温柔、专业的心理咨询师口吻，像在面对面轻声说话。以静静聆听、不过度打扰的方式回应，语气不评判，带着温和的好奇与陪伴感，更像真实对话，不像朗读稿件。节奏自然，句间留一点呼吸感。"
    }
  }
}
```

说明：

- `autoVoiceAccounts` 用来把 `/voice` 限定在指定 agent/bot 上
- `autoVoiceModel` 目前支持：
  - `gemini-2.5-flash-preview-tts`
  - `gemini-2.5-pro-preview-tts`
- `accounts.<accountId>.defaultVoice` 和 `defaultStyle` 是按 bot 维度的默认值

## 认证

### Gemini TTS

在 OpenClaw 所在环境里设置 `GOOGLE_API_KEY`。

插件也可以从本地 `google-tts-tokens.json` 里读取 `gemini_api_key`，但这个文件应当只保留在本地，不要提交到 Git。

### Google Cloud TTS

首次使用前执行：

```bash
node ./src/oauth-setup.mjs
```

这会在插件目录里生成 `google-tts-tokens.json`。这个文件必须保密。

## 命令

- `/voice`：切换当前 Telegram 对话的自动语音
- `/voice on|off|status`
- `/voice_style <文本>`：覆盖当前对话的 style
- `/voice_style 默认`：恢复到账号默认 style
- `/voice_voice <voice>`：覆盖当前对话的 voice
- `/voice_voice 默认`：恢复到账号默认 voice
- `/gtts status`
- `/gtts defaults`
- `/gtts voices [langCode]`
- `/gtts say <text>`
- `/gtts say --pro <text>`
- `/gtts say --flash <text>`
- `/gtts say --style '温柔一点' <text>`
- `/gtts say -e cloud <text>`

## 行为说明

- 自动语音只在 Telegram 上运行，并且只对 `autoVoiceAccounts` 里的账号生效
- 如果回复是 JSON，只会朗读 `response` 字段
- `/new`、`/voice` 这类 slash 指令的回复不会自动转语音
- Telegram 语音气泡由插件在文字发送成功后直接补发
- 手动 `/gtts` 仍然走普通命令回复链路返回媒体

## 不要提交到 Git 的文件

不要提交：

- `google-tts-tokens.json`
- `voice-state.json`
- `voice-config.json`，如果里面放了真实账号 ID 和偏好
- `out/`

目录里附带的 `.gitignore` 已经默认忽略这些文件。
