# google-tts

English: see below. Chinese: [README.zh-CN.md](./README.zh-CN.md)

`google-tts` is an OpenClaw plugin for:

- Gemini TTS
- Google Cloud Text-to-Speech
- Telegram auto voice-bubble replies

It supports manual `/gtts` synthesis and a chat-level `/voice` mode that sends:

- one normal text reply
- one Telegram voice bubble

The auto-voice path is implemented inside the plugin. It does not rely on patching OpenClaw core.

License: MIT. See [LICENSE](./LICENSE).

## Scope to a specific agent/bot

This plugin is designed to be scoped to a specific agent or bot account.

You control that with `voice-config.json`:

- `autoVoiceAccounts` decides which bot accounts can use `/voice`
- `accounts.<accountId>` lets you set per-bot default voice and style

If a bot account is not listed, the auto-voice commands will stay disabled for that bot.

## What is safe to publish

This directory is prepared for GitHub sharing. It intentionally does not include:

- `google-tts-tokens.json`
- `voice-state.json`
- `out/`

Those files are runtime artifacts and may contain credentials, chat state, or generated audio.

## Requirements

- OpenClaw `2026.3.x` or later
- `ffmpeg` available on `PATH`
- A configured Telegram bot in OpenClaw if you want auto voice bubbles
- One of:
  - `GOOGLE_API_KEY` for Gemini TTS
  - OAuth tokens for Google Cloud TTS

## Install

Clone this repo, `cd` into the plugin directory, then install it:

```bash
openclaw plugins install -l .
openclaw plugins doctor
openclaw gateway --force
```

If you prefer a copied install instead of a linked dev install:

```bash
openclaw plugins install .
openclaw plugins doctor
openclaw gateway --force
```

## Configure

1. Copy the example config:

```bash
cp voice-config.example.json voice-config.json
```

2. Edit `voice-config.json`.

Minimal example:

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

Notes:

- `autoVoiceAccounts` scopes `/voice` to a specific agent/bot
- `autoVoiceModel` supports:
  - `gemini-2.5-flash-preview-tts`
  - `gemini-2.5-pro-preview-tts`
- `accounts.<accountId>.defaultVoice` and `defaultStyle` are per-bot defaults

## Auth

### Gemini TTS

Set `GOOGLE_API_KEY` in the environment used by OpenClaw.

The plugin can also read `gemini_api_key` from a local `google-tts-tokens.json`, but that file should stay local and should not be committed.

### Google Cloud TTS

Run the OAuth setup once:

```bash
node ./src/oauth-setup.mjs /path/to/client_secret_*.json
```

You can also set `GOOGLE_OAUTH_CLIENT_SECRET_PATH` instead of passing the path inline.

This writes `google-tts-tokens.json` in the plugin directory. Keep that file private.

## Commands

- `/voice` — toggle auto voice for the current Telegram chat
- `/voice on|off|status`
- `/voice_style <text>` — override style for the current chat
- `/voice_style 默认` — reset to the account default style
- `/voice_voice <voice>` — override voice for the current chat
- `/voice_voice 默认` — reset to the account default voice
- `/gtts status`
- `/gtts defaults`
- `/gtts voices [langCode]`
- `/gtts say <text>`
- `/gtts say --pro <text>`
- `/gtts say --flash <text>`
- `/gtts say --style '自然一点，像对话' <text>`
- `/gtts say -e cloud <text>`

## Behavior notes

- Auto voice runs only for Telegram and only for accounts in `autoVoiceAccounts`
- JSON replies are spoken from the `response` field only
- Slash-command replies such as `/new` and `/voice` are skipped by auto voice
- Telegram voice bubbles are sent directly by the plugin after text delivery
- Manual `/gtts` still returns media via the normal command reply path
- Gemini requests use the `x-goog-api-key` header instead of placing the API key in the URL

## Files to keep out of git

Do not commit:

- `google-tts-tokens.json`
- `voice-state.json`
- `voice-config.json` if it contains your real account IDs and preferences
- `out/`

The included `.gitignore` already excludes those files.
