# Telegram Controller Bot

A Node.js-based Telegram Controller Bot system. It allows users to register their own custom bots (via `@BotFather` API tokens), pair them to their channels, and use those custom bots as private posting terminals to draft, preview, and send text-and-emoji messages to their channels.

## Features
- **Dynamic Multi-Bot Management**: Start, stop, and hot-load custom user bots on-the-fly without restarting the main server.
- **Access Control**: Custom bots are locked to their respective owners; unauthorized messages are ignored.
- **Emoji-enabled Rich Texts**: Send text messages with custom emojis natively.
- **Post Previews & Drafts**: Preview drafts before posting or cancel to discard them.
- **PostgreSQL Persistence**: Saves bot connections, paired channels, active user states, and drafts in PostgreSQL.

---

## Prerequisites
- **Node.js**: v18 or later.
- **PostgreSQL Database**: A running PostgreSQL instance (local or hosted, e.g., Neon, Supabase, ElephantSQL, etc.) with a connection string URL.
- **Telegram Account**: To create bots via `@BotFather`.

---

## Setup & Installation

1. **Clone or navigate to the project directory** and make sure dependencies are installed:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and fill in the configuration options:
   - `TELEGRAM_BOT_TOKEN`: The API token of your main Controller Bot (created via `@BotFather`).
   - `DATABASE_URL`: Your PostgreSQL connection URL (e.g., `postgresql://username:password@hostname:5432/database_name?sslmode=require`).

3. **Start the Application**:
   Run the bot:
   ```bash
   npm start
   ```
   On startup, the system will automatically connect to PostgreSQL and run queries to initialize the required tables (`users`, `bots`, `channels`, and `drafts`) if they do not exist.

---

## How to Use the Controller Bot

### Step 1: Pairing a Custom Bot and Channel
1. Search for your main Controller Bot on Telegram and send `/start`.
2. Send `/addchannel` to start the wizard.
3. Open `@BotFather` on Telegram, create a new bot using `/newbot`, and copy the **API Token** it provides.
4. Send the API Token to the main Controller Bot.
5. The Controller Bot will verify the token, register the bot, and dynamically spin it up.
6. Now, add your new custom bot as an **Administrator** in your target Telegram Channel with **Post Messages** permissions enabled.
7. Forward any message from that channel to the main Controller Bot, or simply send the channel's **Username** (e.g., `@mychannel`) or numeric **ID** (e.g., `-1001234567890`) to the Controller Bot.
8. Once verified, the channel is successfully linked to your custom bot!

### Step 2: Posting Messages via your Custom Bot
1. Open your newly created custom bot on Telegram and send `/start` or `/newpost`.
2. If you have connected multiple channels, the bot will ask you to select which channel you want to post to. If only one channel is connected, it selects it automatically.
3. The bot will prompt you to send your post content.
4. Send your text message (emojis are fully supported!). 
   *Note: Only text messages are accepted. Files, photos, videos, and stickers are rejected to ensure text-only posting.*
5. The bot will save your draft and provide three options via inline buttons:
   - 👁️ **Preview**: Sends a preview message showing exactly how it will appear in the channel.
   - 📤 **Send**: Publishes the message directly to the channel and clears the draft.
   - ❌ **Cancel**: Discards the draft and resets your posting session.
