# google-tts

中文说明。English version: [README.md](./README.md).

`google-tts` 是一个 OpenClaw 插件，提供：

- Gemini TTS
- Google Cloud Text-to-Speech
- Telegram 自动语音气泡回复

它支持手动 `/gtts` 合成，也支持聊天级别的 `/voice` 模式。开启 `/voice` 后，bot 会先发送正常文字，再补发一条对应的 Telegram 语音气泡。

这个插件可以按 bot 账号做范围控制。哪些 bot 允许使用自动语音，由 `voice-config.json` 决定。

许可证：MIT。见 [LICENSE](./LICENSE)。

## 环境要求

- OpenClaw `2026.3.x` 或更高
- 系统中有 `ffmpeg`
- 如果要使用 Telegram 语音气泡，需要先在 OpenClaw 中配置 Telegram bot
- 认证方式二选一：
  - Gemini TTS 使用 `GOOGLE_API_KEY`
  - Google Cloud TTS 使用 OAuth 凭证

## 安装

在插件目录中执行：

```bash
openclaw plugins install -l .
openclaw plugins doctor
openclaw gateway --force
```

如果你不想使用 link 模式，也可以直接复制安装：

```bash
openclaw plugins install .
openclaw plugins doctor
openclaw gateway --force
```

## 配置

先复制示例配置，再按你的 bot 修改：

```bash
cp voice-config.example.json voice-config.json
```

示例：

```json
{
  "autoVoiceAccounts": ["your-bot-account-id"],
  "autoVoiceModel": "gemini-2.5-flash-preview-tts",
  "accounts": {
    "your-bot-account-id": {
      "defaultVoice": "Leda",
      "defaultStyle": "请用自然、温和、专业的口吻表达。语气不评判，带一点自然的回应感，节奏自然，更像真实对话，不像朗读稿件。"
    }
  }
}
```

配置含义：

- `autoVoiceAccounts` 用来限制哪些 bot 可以使用 `/voice`
- `autoVoiceModel` 可选 `gemini-2.5-flash-preview-tts` 或 `gemini-2.5-pro-preview-tts`
- `accounts.<accountId>.defaultVoice` 和 `defaultStyle` 是按 bot 设置的默认值

## 认证

### Gemini TTS

在 OpenClaw 运行环境中设置 `GOOGLE_API_KEY`。

插件也可以从本地 `google-tts-tokens.json` 中读取 `gemini_api_key`，但这个文件应当只保留在本地，不要提交到 Git。

### Google Cloud TTS

首次运行一次 OAuth setup：

```bash
node ./src/oauth-setup.mjs /path/to/client_secret_*.json
```

你也可以设置 `GOOGLE_OAUTH_CLIENT_SECRET_PATH`，这样就不用把路径写在命令行里。

执行后会在插件目录生成 `google-tts-tokens.json`。这个文件必须保密。

## 命令

- `/voice`：切换当前 Telegram 对话的自动语音
- `/voice on|off|status`
- `/voice_style <文本>`：覆盖当前对话的 style
- `/voice_style 默认`：恢复为账号默认 style
- `/voice_voice <voice>`：覆盖当前对话的 voice
- `/voice_voice 默认`：恢复为账号默认 voice
- `/gtts status`
- `/gtts defaults`
- `/gtts voices [langCode]`
- `/gtts say <text>`
- `/gtts say --pro <text>`
- `/gtts say --flash <text>`
- `/gtts say --style '自然一点，像对话' <text>`
- `/gtts say -e cloud <text>`

## 说明

- 自动语音只在 Telegram 上运行，并且只对 `autoVoiceAccounts` 中的账号生效
- 如果回复内容是 JSON，只会朗读 `response` 字段
- `/new`、`/voice` 这类 slash 指令的回复不会自动转语音
- Telegram 语音气泡由插件在文字发送成功后直接补发
- Gemini 请求使用 `x-goog-api-key` 请求头，不把 API key 放在 URL 中
- 不要提交 `google-tts-tokens.json`、`voice-state.json`、`voice-config.json` 或 `out/`
