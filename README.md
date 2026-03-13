# google-tts

English. 中文说明见 [README.zh-CN.md](./README.zh-CN.md).

`google-tts` is an OpenClaw plugin for:

- Gemini TTS
- Google Cloud Text-to-Speech
- Telegram voice-bubble replies

Use `/gtts` for manual synthesis. Use `/autovoice` to make a Telegram bot send text first and then send the same reply as a voice bubble.

This public version uses `/autovoice` instead of `/voice`, because some OpenClaw installs already reserve `/voice`.

License: MIT. See [LICENSE](./LICENSE).

## Requirements

- OpenClaw `2026.3.x` or later
- `ffmpeg` on `PATH`
- A Telegram bot configured in OpenClaw if you want auto voice bubbles
- One of:
  - `GOOGLE_API_KEY` for Gemini TTS
  - OAuth credentials for Google Cloud TTS
- `ffmpeg` is used for local audio conversion

## Install

From the plugin directory:

```bash
openclaw plugins install -l .
openclaw plugins doctor
openclaw gateway --force
```

If you prefer a copied install instead of a linked one:

```bash
openclaw plugins install .
openclaw plugins doctor
openclaw gateway --force
```

## Configure

Copy the example config and replace `your-bot-account-id` with your bot account id:

```bash
cp voice-config.example.json voice-config.json
```

Example:

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

What the config means:

- `autoVoiceAccounts`: which bot accounts are allowed to use auto voice
- `autoVoiceModel`: `gemini-2.5-flash-preview-tts` or `gemini-2.5-pro-preview-tts`
- `accounts.<accountId>.defaultVoice`: default voice for that bot
- `accounts.<accountId>.defaultStyle`: default speaking style for that bot

## Auth

### Gemini TTS

Set `GOOGLE_API_KEY` in the environment used by OpenClaw.

The plugin can also read `gemini_api_key` from a local `google-tts-tokens.json`, but that file should stay local and should not be committed.

### Google Cloud TTS

Run the OAuth setup once:

```bash
node ./src/oauth-setup.mjs /path/to/client_secret_*.json
```

You can also set `GOOGLE_OAUTH_CLIENT_SECRET_PATH` instead of passing the path on the command line.

This creates `google-tts-tokens.json` in the plugin directory. Keep that file private.

## How To Use

1. Install the plugin.
2. Create `voice-config.json`.
3. Configure Gemini or Google Cloud auth.
4. Restart the gateway.
5. In Telegram, talk to the configured bot.
6. Send `/autovoice on` in that chat.
7. Send a normal message. The bot should reply with text first, then a voice bubble.

## Commands

- `/autovoice` toggles auto voice for the current Telegram chat
- `/autovoice on|off|status`
- `/voice_style <text>` overrides style for the current chat
- `/voice_style 默认` resets style to the account default
- `/voice_voice <voice>` overrides voice for the current chat
- `/voice_voice 默认` resets voice to the account default
- `/gtts status`
- `/gtts defaults`
- `/gtts voices [langCode]`
- `/gtts say <text>`
- `/gtts say --pro <text>`
- `/gtts say --flash <text>`
- `/gtts say --style '自然一点，像对话' <text>`
- `/gtts say -e cloud <text>`

## Notes

- Auto voice only runs on Telegram
- Auto voice only works for bot accounts listed in `autoVoiceAccounts`
- JSON replies only speak the `response` field
- Slash-command replies such as `/new` are not spoken
- Keep `google-tts-tokens.json`, `voice-state.json`, `voice-config.json`, and `out/` out of Git
