# @teleton-agent/sdk

**Plugin SDK for Teleton Agent** — TypeScript types and utilities for building plugins that interact with Telegram and the TON blockchain.

[![npm](https://img.shields.io/npm/v/@teleton-agent/sdk?style=flat-square)](https://www.npmjs.com/package/@teleton-agent/sdk)
[![license](https://img.shields.io/npm/l/@teleton-agent/sdk?style=flat-square)](https://github.com/TONresistor/teleton-agent/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-blue?style=flat-square)](https://www.typescriptlang.org/)

---

## Install

```bash
npm install @teleton-agent/sdk
```

The package ships type definitions and the `PluginSDKError` class. It has an optional peer dependency on `better-sqlite3` (used only if your plugin needs a database).

## Quick Start

A Teleton plugin is a module that exports a `tools` function and, optionally, `manifest`, `start`, and `migrate`.

```typescript
import type { PluginSDK, SimpleToolDef, PluginManifest } from "@teleton-agent/sdk";

export const manifest: PluginManifest = {
  name: "greeting",
  version: "1.0.0",
  description: "Sends a greeting with the bot's TON balance",
};

export const tools = (sdk: PluginSDK): SimpleToolDef[] => [
  {
    name: "greeting_hello",
    description: "Greet the user and show the bot wallet balance",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "User's name" },
      },
      required: ["name"],
    },
    async execute(params, context) {
      const balance = await sdk.ton.getBalance();
      const text = `Hello ${params.name}! Bot balance: ${balance?.balance ?? "unknown"} TON`;
      await sdk.telegram.sendMessage(String(context.chatId), text);
      return { success: true, data: { greeting: text } };
    },
  },
];
```

Place the compiled plugin at `~/.teleton/plugins/<name>/index.js` and register it in `config.yaml`:

```yaml
plugins:
  greeting:
    enabled: true
```

## Plugin Lifecycle

The core platform loads plugins in a defined order. Each export is optional except `tools`.

| Export | Signature | When Called | Purpose |
|--------|-----------|------------|---------|
| `manifest` | `PluginManifest` | Load time | Declares name, version, dependencies, default config |
| `migrate` | `(db: Database) => void` | Before `tools`, once | Create/alter tables in the plugin's isolated SQLite DB |
| `tools` | `SimpleToolDef[] \| (sdk: PluginSDK) => SimpleToolDef[]` | After migrate | Register tools the LLM can invoke |
| `start` | `(ctx) => Promise<void>` | After bridge connects | Run background tasks, set up intervals |
| `stop` | `() => Promise<void>` | On shutdown / hot-reload | Cleanup timers, close connections |
| `onMessage` | `(event: PluginMessageEvent) => Promise<void>` | Every incoming message | React to messages without LLM involvement |
| `onCallbackQuery` | `(event: PluginCallbackEvent) => Promise<void>` | Inline button press | Handle callback queries from inline keyboards |

The `tools` export can be either a static array or a factory function receiving the SDK. The `start` function receives a context object with `db`, `config`, `pluginConfig`, and `log`. The SDK object passed to `tools` is **frozen** -- plugins cannot modify or extend it. Each plugin receives its own isolated database (if `migrate` is exported) and a sanitized config object with no API keys.

### Event Hooks

Plugins can export `onMessage` and `onCallbackQuery` to react to Telegram events directly, without going through the LLM agentic loop. These hooks are **fire-and-forget** — errors are caught per plugin and logged, so a failing hook never blocks message processing or other plugins.

#### `onMessage`

Called for every incoming message (DMs and groups), after the message is stored to the feed database. This fires regardless of whether the agent will respond to the message.

```typescript
import type { PluginMessageEvent } from "@teleton-agent/sdk";

export async function onMessage(event: PluginMessageEvent) {
  // Auto-moderation example: delete messages containing banned words
  if (event.isGroup && /spam|scam/i.test(event.text)) {
    console.log(`Flagged message ${event.messageId} from ${event.senderId}`);
  }
}
```

#### `onCallbackQuery`

Called when a user presses an inline keyboard button. The `data` string is split on `:` into `action` (first segment) and `params` (remaining segments). **You must call `event.answer()`** to dismiss the loading spinner on the user's client.

```typescript
import type { PluginCallbackEvent } from "@teleton-agent/sdk";

export async function onCallbackQuery(event: PluginCallbackEvent) {
  // Button data format: "myplugin:action:param1:param2"
  if (event.action !== "myplugin") return; // Not for this plugin

  const [subAction, ...args] = event.params;

  if (subAction === "confirm") {
    await event.answer("Confirmed!", false); // Toast notification
    // ... handle the confirmation
  } else {
    await event.answer("Unknown action", true); // Alert popup
  }
}
```

> **Tip:** Namespace your callback data with your plugin name (e.g. `"casino:bet:100"`) so multiple plugins can coexist without action collisions. All registered `onCallbackQuery` hooks receive every callback event — filter by `event.action` to handle only your own buttons.

## API Reference

### Core

#### `PluginSDK`

Root SDK object passed to plugin functions.

| Property | Type | Description |
|----------|------|-------------|
| `version` | `string` | SDK version (semver) |
| `ton` | `TonSDK` | TON blockchain operations |
| `telegram` | `TelegramSDK` | Telegram messaging operations |
| `db` | `Database \| null` | Isolated SQLite database (null if no `migrate` exported) |
| `config` | `Record<string, unknown>` | Sanitized app config (no secrets) |
| `pluginConfig` | `Record<string, unknown>` | Plugin-specific config from `config.yaml` |
| `log` | `PluginLogger` | Prefixed logger |

#### `PluginLogger`

All methods auto-prefix output with the plugin name.

| Method | Description |
|--------|-------------|
| `info(...args)` | Informational message |
| `warn(...args)` | Warning |
| `error(...args)` | Error |
| `debug(...args)` | Debug (visible only when `DEBUG` or `VERBOSE` is set) |

#### `PluginSDKError`

```typescript
import { PluginSDKError } from "@teleton-agent/sdk";
```

Extends `Error` with a `code` property for programmatic handling.

| Property | Type | Description |
|----------|------|-------------|
| `name` | `"PluginSDKError"` | Always `"PluginSDKError"` |
| `code` | `SDKErrorCode` | Machine-readable error code |
| `message` | `string` | Human-readable description |

#### `SDKErrorCode`

```typescript
type SDKErrorCode =
  | "BRIDGE_NOT_CONNECTED"   // Telegram bridge not ready
  | "WALLET_NOT_INITIALIZED" // TON wallet not configured
  | "INVALID_ADDRESS"        // Malformed TON address
  | "OPERATION_FAILED";      // Generic failure
```

#### `SDK_VERSION`

```typescript
import { SDK_VERSION } from "@teleton-agent/sdk";
// "1.0.0"
```

---

### TON

#### `TonSDK`

| Method | Returns | Description |
|--------|---------|-------------|
| `getAddress()` | `string \| null` | Bot's wallet address |
| `getBalance(address?)` | `Promise<TonBalance \| null>` | Balance for an address (defaults to bot) |
| `getPrice()` | `Promise<TonPrice \| null>` | Current TON/USD price (cached 30s) |
| `sendTON(to, amount, comment?)` | `Promise<TonSendResult>` | Send TON (irreversible) |
| `getTransactions(address, limit?)` | `Promise<TonTransaction[]>` | Transaction history (max 50) |
| `verifyPayment(params)` | `Promise<SDKPaymentVerification>` | Verify incoming payment with replay protection |

#### `TonBalance`

| Field | Type | Description |
|-------|------|-------------|
| `balance` | `string` | Human-readable (e.g. `"12.50"`) |
| `balanceNano` | `string` | Balance in nanoTON |

#### `TonPrice`

| Field | Type | Description |
|-------|------|-------------|
| `usd` | `number` | Price in USD |
| `source` | `string` | `"TonAPI"` or `"CoinGecko"` |
| `timestamp` | `number` | Fetch time (ms since epoch) |

#### `TonSendResult`

| Field | Type | Description |
|-------|------|-------------|
| `txRef` | `string` | Reference: `seqno_timestamp_amount` |
| `amount` | `number` | Amount sent in TON |

#### `TonTransaction`

| Field | Type | Description |
|-------|------|-------------|
| `type` | `TransactionType` | Transaction type |
| `hash` | `string` | Blockchain tx hash (hex) |
| `amount` | `string?` | e.g. `"1.5 TON"` |
| `from` | `string?` | Sender address |
| `to` | `string?` | Recipient address |
| `comment` | `string \| null?` | Transaction memo |
| `date` | `string` | ISO 8601 date |
| `secondsAgo` | `number` | Age in seconds |
| `explorer` | `string` | Tonviewer link |
| `jettonAmount` | `string?` | Raw jetton amount |
| `jettonWallet` | `string?` | Jetton wallet address |
| `nftAddress` | `string?` | NFT address |
| `transfers` | `TonTransaction[]?` | Sub-transfers (for `multi_send`) |

#### `TransactionType`

```typescript
type TransactionType =
  | "ton_received" | "ton_sent"
  | "jetton_received" | "jetton_sent"
  | "nft_received" | "nft_sent"
  | "gas_refund" | "bounce"
  | "contract_call" | "multi_send";
```

#### `SDKVerifyPaymentParams`

| Field | Type | Description |
|-------|------|-------------|
| `amount` | `number` | Expected amount in TON |
| `memo` | `string` | Expected comment (e.g. username) |
| `gameType` | `string` | Replay protection group |
| `maxAgeMinutes` | `number?` | Time window (default: 10) |

#### `SDKPaymentVerification`

| Field | Type | Description |
|-------|------|-------------|
| `verified` | `boolean` | Whether payment was found and valid |
| `txHash` | `string?` | Transaction hash (replay protection) |
| `amount` | `number?` | Verified amount |
| `playerWallet` | `string?` | Sender wallet (for payouts) |
| `date` | `string?` | ISO 8601 date |
| `secondsAgo` | `number?` | Age in seconds |
| `error` | `string?` | Failure reason |

---

### Telegram

#### `TelegramSDK`

| Method | Returns | Description |
|--------|---------|-------------|
| `sendMessage(chatId, text, opts?)` | `Promise<number>` | Send message, returns message ID |
| `editMessage(chatId, messageId, text, opts?)` | `Promise<number>` | Edit existing message |
| `sendDice(chatId, emoticon, replyToId?)` | `Promise<DiceResult>` | Send dice/slot animation |
| `sendReaction(chatId, messageId, emoji)` | `Promise<void>` | React to a message |
| `getMessages(chatId, limit?)` | `Promise<SimpleMessage[]>` | Fetch recent messages (default 50) |
| `getMe()` | `TelegramUser \| null` | Bot's user info |
| `isAvailable()` | `boolean` | Whether the bridge is connected |

#### `SendMessageOptions`

| Field | Type | Description |
|-------|------|-------------|
| `replyToId` | `number?` | Message ID to reply to |
| `inlineKeyboard` | `Array<Array<{text, callback_data}>>?` | Inline keyboard rows |

#### `EditMessageOptions`

| Field | Type | Description |
|-------|------|-------------|
| `inlineKeyboard` | `Array<Array<{text, callback_data}>>?` | Updated keyboard (omit to keep) |

#### `DiceResult`

| Field | Type | Description |
|-------|------|-------------|
| `value` | `number` | Result value (range depends on emoticon) |
| `messageId` | `number` | Message ID of the dice |

#### `TelegramUser`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Telegram user ID |
| `username` | `string?` | Username (without `@`) |
| `firstName` | `string?` | First name |
| `isBot` | `boolean` | Whether the user is a bot |

#### `SimpleMessage`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Message ID |
| `text` | `string` | Message text |
| `senderId` | `number` | Sender user ID |
| `senderUsername` | `string?` | Sender username |
| `timestamp` | `Date` | Message timestamp |

---

### Plugin Definitions

#### `SimpleToolDef`

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique tool name (e.g. `"casino_spin"`) |
| `description` | `string` | Description for the LLM |
| `parameters` | `Record<string, unknown>?` | JSON Schema for params |
| `execute` | `(params, context) => Promise<ToolResult>` | Tool handler |
| `scope` | `ToolScope?` | Visibility scope (default: `"always"`) |
| `category` | `ToolCategory?` | Masking category |

#### `PluginManifest`

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Plugin name (lowercase, hyphens, 1-64 chars) |
| `version` | `string` | Semver string |
| `author` | `string?` | Author name |
| `description` | `string?` | Short description (max 256 chars) |
| `dependencies` | `string[]?` | Required built-in modules |
| `defaultConfig` | `Record<string, unknown>?` | Default config values |
| `sdkVersion` | `string?` | Required SDK version range |

#### `ToolResult`

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether execution succeeded |
| `data` | `unknown?` | Result data (serialized for LLM) |
| `error` | `string?` | Error message |

#### `ToolScope`

```typescript
type ToolScope = "always" | "dm-only" | "group-only" | "admin-only";
```

#### `ToolCategory`

```typescript
type ToolCategory = "data-bearing" | "action";
```

`data-bearing` tool results are subject to observation masking (token reduction on older results). `action` tool results are always preserved in full.

---

### Event Hook Types

#### `PluginMessageEvent`

| Field | Type | Description |
|-------|------|-------------|
| `chatId` | `string` | Telegram chat ID |
| `senderId` | `number` | Sender's user ID |
| `senderUsername` | `string?` | Sender's `@username` (without `@`) |
| `text` | `string` | Message text |
| `isGroup` | `boolean` | Whether this is a group chat |
| `hasMedia` | `boolean` | Whether the message contains media |
| `messageId` | `number` | Message ID |
| `timestamp` | `Date` | Message timestamp |

#### `PluginCallbackEvent`

| Field | Type | Description |
|-------|------|-------------|
| `data` | `string` | Raw callback data string |
| `action` | `string` | First segment of `data.split(":")` |
| `params` | `string[]` | Remaining segments after action |
| `chatId` | `string` | Chat ID where the button was pressed |
| `messageId` | `number` | Message ID the button belongs to |
| `userId` | `number` | User ID who pressed the button |
| `answer` | `(text?: string, alert?: boolean) => Promise<void>` | Answer the callback query (dismisses spinner) |

## Error Handling

All SDK methods that perform I/O throw `PluginSDKError` on failure. Use the `code` property for control flow:

```typescript
import { PluginSDKError } from "@teleton-agent/sdk";

async execute(params, context) {
  try {
    await sdk.ton.sendTON(params.address, params.amount);
    return { success: true };
  } catch (err) {
    if (err instanceof PluginSDKError) {
      switch (err.code) {
        case "WALLET_NOT_INITIALIZED":
          return { success: false, error: "Bot wallet not configured" };
        case "INVALID_ADDRESS":
          return { success: false, error: "Bad address format" };
        default:
          return { success: false, error: err.message };
      }
    }
    throw err; // Re-throw unexpected errors
  }
}
```

Always check `telegram.isAvailable()` before calling Telegram methods in `start()`, since the bridge may not be connected yet.

## License

MIT -- see [LICENSE](https://github.com/TONresistor/teleton-agent/blob/main/LICENSE).

Copyright 2025-2026 Digital Resistance.

## Links

- [Repository](https://github.com/TONresistor/teleton-agent)
- [Issues](https://github.com/TONresistor/teleton-agent/issues)
- [Teleton Agent](https://github.com/TONresistor/teleton-agent) -- the main project
