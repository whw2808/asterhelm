# Self-host Asterhelm

Run the hub and one worker on a macOS or Linux account you control. The hub keeps the queue and dashboard in a private directory. A worker runs a native executable on its own device. The phone connects to the hub through an HTTPS gateway.

| Component | Requirements |
| --- | --- |
| Hub and workers | Node.js 24 or newer with `node:sqlite`. Run the commands below from the repository root. |
| First-run check | `/usr/bin/wc` on the worker. The check needs no model credentials. |
| Codex or DeepSeek Harness | The selected executor installed and authenticated under the worker’s account. |
| File handoffs | Python 3 on each participating worker. |
| Remote workers | OpenSSL on the hub and on each device for enrollment, plus `/usr/bin/curl` on the worker. |
| Physical phone | A hostname that resolves from the phone and an HTTPS certificate trusted by its browser. Terminal QR codes also use the optional `qrencode` executable. |

## Run your first task

The default state directory is `~/.asterhelm`. To choose a different location, export `ASTERHELM_HOME` in every terminal before starting. Use a private directory outside the clone. The launcher creates it with mode `0700`. The following commands use the device ID `hub`.

On the hub, initialize the state and start the three foreground services.

```sh
node scripts/asterhelm.mjs init
node scripts/asterhelm.mjs configure-worker --adapter check
node scripts/asterhelm.mjs hub
```

In a second terminal, start the example worker.

```sh
node scripts/asterhelm.mjs worker hub.check
```

In a third terminal, wait until `hub.check` has `"online": true`, then submit a task. Copy its returned `id` into the last command.

```sh
node server/control.mjs workers
node server/control.mjs submit hub.check 'Hello'
node server/control.mjs get TASK_ID
```

The worker runs `wc -c` on the five letters and a trailing newline. Within a few seconds the task should have `"state": "succeeded"` and `"result": "6"`. Ctrl+C stops each foreground process. On subsequent starts, run only the `hub` and `worker` commands. Each generated worker config lives at `$ASTERHELM_HOME/workers/<target>/worker.json`, where `ASTERHELM_HOME` defaults to `$HOME/.asterhelm`.

The default broker accepts local requests through its Unix socket. The phone gateway listens on `127.0.0.1:42852`. The example runs with the planner offline. The queue, phone pairing, board, and history work in this mode. Chat needs one of the planners below.

## Run a model-backed worker

With an authenticated Codex CLI on the worker’s PATH, run these commands on the hub for a local worker.

```sh
node scripts/asterhelm.mjs configure-worker --adapter codex
node scripts/asterhelm.mjs worker hub.codex
```

The worker uses the model in the owner's Codex configuration. Pass `--model MODEL_ID` during configuration to select a specific model, or `--executable /absolute/path/to/codex` for a private installation. Use `--write` at configuration time if this worker should accept workspace writes and produce handoff files. Read-only workers can consume a handoff. Jobs run in a directory dedicated to that task under `workers/<target>/workspaces/`. The adapter passes the selected permission mode to the executor.

DeepSeek Harness uses an existing installation with a headless profile. Choose a model in the harness's web profile first. The planner reads its selected provider and model from `profiles/web/cordis.patch.yml` under your harness home. Supply the absolute path to the harness JavaScript entry point, its private home and a YAML sequence of headless profile patches. A file containing `[]` works when your profile has all its settings.

```sh
node scripts/asterhelm.mjs configure-worker --adapter deepseek \
  --dsh-entry "$DSH_ENTRY" --dsh-home "$DSH_HOME" --dsh-patch "$DSH_PATCH"
node scripts/asterhelm.mjs worker hub.deepseek
```

Set the three shell variables to paths from your installation before running the commands. The harness installation must expose its `js-yaml` dependency and support the headless flags `--profile`, `--patch`, `--permission-mode` and `--approval-policy`. Worker configuration records paths to runtime files. Model credentials stay in your existing login, harness profile, or process environment.

## Configure the chat planner

The planner receives your chat, recent conversation history, visible session excerpts, and worker or task summaries. Choose the model service you want to receive that data. Workers and the planner have separate configurations. A Codex worker can execute tasks assigned by either planner below.

**DeepSeek Harness.** To use the same local harness installation for planning, point the hub at the generated DeepSeek worker configuration. Stop any running hub, then start it in that shell.

```sh
export ASTERHELM_HOME="${ASTERHELM_HOME:-$HOME/.asterhelm}"
export PERSONAL_AGENT_ENGINE=dsh
export PERSONAL_AGENT_DSH_CONFIG="$ASTERHELM_HOME/workers/hub.deepseek/worker.json"
node scripts/asterhelm.mjs hub
```

**Chat Completions API.** Alternatively, use a provider with an HTTPS Chat Completions endpoint and JSON-object response support. Create a private env file on the hub, fill it with your provider's real values, then use Node’s env-file loader to start the hub. The hostname and values below are placeholders.

```dotenv
PERSONAL_AGENT_ENGINE=chat-api
PERSONAL_AGENT_API_URL=https://models.example.test/v1/chat/completions
PERSONAL_AGENT_MODEL=your-model-id
PERSONAL_AGENT_API_KEY=your-provider-key
```

```sh
chmod 600 "$HOME/.asterhelm/planner.env"
node --env-file="$HOME/.asterhelm/planner.env" scripts/asterhelm.mjs hub
```

For the direct DeepSeek API preset, set `PERSONAL_AGENT_ENGINE=deepseek-api`, `PERSONAL_AGENT_MODEL`, and `DEEPSEEK_API_KEY` in the env file. In either mode, a greeting in the paired phone browser checks the real provider connection. A provider account, API key, or live model subscription is supplied by the operator.

## Pair the phone web interface

1. Choose an HTTPS origin on a hostname you control. Configure a reverse proxy on the hub to terminate TLS for that origin and forward all requests to `127.0.0.1:42852`. Keep the broker's private worker port separate. For example, a Caddy site block can look like this after you replace the placeholder hostname and configure DNS and certificate trust. See [Caddy’s reverse proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

   ```caddyfile
   assistant.example.test {
       reverse_proxy 127.0.0.1:42852
   }
   ```

2. Set the exact external origin in **both** the hub terminal and the pairing terminal. Include any nonstandard port. Restart the hub with this setting and the planner settings you chose above.

   ```sh
   export ASTERHELM_PUBLIC_ORIGIN=https://assistant.example.test
   ```

3. From the pairing terminal, issue an invitation. Open it privately on the phone, or scan the terminal QR with its camera.

   ```sh
   node scripts/asterhelm.mjs pair --qr
   ```

   `node scripts/asterhelm.mjs pair` prints just the link. The invitation is valid for 15 minutes and can be redeemed once. The code is in the URL fragment. The gateway gives the browser a secure, HTTP-only session cookie valid for 90 days. Use the web option on the landing page if the Android client is also offered. Logging out revokes that session.

The launcher's default origin is `https://localhost`. A physical phone needs the actual HTTPS hostname above. To change the gateway's loopback port, set `SUPER_AGENT_PHONE_PORT` when starting the hub and point the reverse proxy to the new port. Android installation and origin configuration are covered in the [Android guide](../android/README.md).

## Enroll a second device with mutual TLS

Choose the private interface address of the hub and a hostname reachable from the worker. In the commands below, replace `broker.example.test` and the documentation address `192.0.2.10` with those values. Use a unique lowercase ID for each remote device, such as `node-b`. Run each command from a clone on the indicated machine. Each machine has its own `ASTERHELM_HOME`.

**On the hub**, stop the hub and initialize its worker certificate authority and broker certificate. This writes the listener settings into the existing private `broker.json`. Restart the hub with the same planner and phone settings as before.

```sh
node scripts/pki.mjs init --host broker.example.test --bind 192.0.2.10 --port 42851
node scripts/asterhelm.mjs hub
```

**On the remote worker**, generate its private key and certificate signing request. Send only the printed `client.csr` to the hub owner through a channel that authenticates the requesting device. The key stays on the worker.

```sh
node scripts/pki.mjs request --device node-b
```

**On the hub**, check the device identity with its owner, then issue its certificate. Replace the example CSR path with the received file.

```sh
node scripts/pki.mjs sign --device node-b --csr /path/to/received/client.csr
```

Send `pki/issued/node-b.crt` and `pki/ca.crt` from the hub state directory to that worker using an authenticated channel. Install them as `pki/client.crt` and `pki/ca.crt` in the worker state directory beside the original `client.key`. The hub's `pki/ca.key` can issue identities and belongs with the hub owner.

**On the remote worker**, start a remote check worker with the signed identity. The same procedure works with `--adapter codex` or `--adapter deepseek` and its local harness paths.

```sh
node scripts/asterhelm.mjs configure-worker --adapter check --device node-b \
  --server broker.example.test --port 42851
node scripts/asterhelm.mjs worker node-b.check
```

On the hub, `node server/control.mjs workers` should now show `node-b.check` online. Submit the byte-count task again using that target. Each remote certificate authorizes its named device to register workers in that device's namespace. Restrict access to the chosen interface and port to your worker network. The phone uses the web gateway's independent HTTPS certificate.

The helper issues one-year leaf certificates. Plan certificate replacement before expiry. The broker trusts certificates issued by its configured CA and has no per-certificate revocation list. To retire a compromised identity immediately, take the listener offline, rotate the CA and broker certificate, and re-enroll the remaining devices. Protect an offline backup of private state and keys according to your deployment’s recovery needs.

## Optional session context and inventory

A generated worker declares zero context sources and leaves hardware reporting off. To share Codex session context, choose one worker per device, stop it, and edit its private `worker.json`. Set `registration.contextSources` to `["Codex Desktop", "Codex CLI"]` and `codexHome` to the absolute path of the local Codex state you want to read. Restart the worker, then run the connector on that same machine.

```sh
node server/context-sync.mjs "${ASTERHELM_HOME:-$HOME/.asterhelm}/workers/hub.codex/worker.json"
```

Replace `hub.codex` with the configured target. The connector reads compatible local SQLite session metadata and recent user and assistant excerpts, including project paths. It periodically posts changes to the hub. Paired devices and your configured planner can see the resulting context. Stop the connector to stop further transfers. The last synced snapshot remains on the hub. To include a worker's reported OS, architecture and GPU observations on the board, set its top-level `reportHardware` field to `true` and restart it.

## Operations and troubleshooting

| Symptom | What to check |
| --- | --- |
| Worker stays offline | Keep the hub and worker foreground processes running. Check that both local commands use the same state directory. On a remote worker, check the certificate CN, CA, DNS hostname, clock, and port. |
| Worker has registered but jobs fail | Run the selected executor under the same OS account and check its model login and the supported permission modes. |
| Pairing rejected or chat returns an origin error | Verify the trusted HTTPS hostname, exact external port, `ASTERHELM_PUBLIC_ORIGIN` in both terminals, and an unused, unexpired invitation. |
| Board works and chat is unavailable | Restart the hub with one configured planner. For a harness planner, verify both the selected model in its web profile and the credentials available to its headless profile. |
| A listener or worker is already running | Stop the original foreground command before starting a second copy against the same state. |
| Need to update worker configuration | Stop the worker, edit its private JSON and restart. The setup command refuses to overwrite an existing worker configuration. |

Stop all processes before making a consistent filesystem backup of `ASTERHELM_HOME`. It contains SQLite databases and journals, job workspaces, phone session records, optional context snapshots, and optional private keys. A remote worker has its own state to back up.

To exercise setup and enrollment on a development machine, run `node --test scripts/self-host.test.mjs`. It runs disposable services on loopback, generates a temporary test CA, and discards the state at the end. The suite exercises the first-run byte count over the local socket and mTLS, phone pairing, the board and logout. A synthetic HTTPS model endpoint dispatches a read-only task to a stand-in native executor and checks that its receipt reaches the conversation. A stand-in headless harness also checks DeepSeek worker configuration and the planner’s tool-disabling patch. The suite needs no external model or phone.

### Check the coordinator’s token usage

Open **看板 → Token 用量** or ask “星舵今天用了多少 token？” in the paired chat. The service counts model calls for conversation planning, delivery, autonomous work checks and scheduled reviews. The reporting day starts at midnight in the coordinator host’s local time zone. Reading the meter uses the local SQLite ledger and makes no model request.

Counting begins when the upgraded coordinator starts. Existing chat history and worker receipts contain no reliable token totals for earlier use. The ledger stores call time, phase, model when available and token counts. It uses provider-reported usage, includes cached input once within input, and flags missing or partial reports. For DeepSeek Harness, the headless CLI must advertise `--json` and report usage in its `step_end` events to populate the meter. Plaintext-only versions can still answer and their calls appear as unreported. Worker inference and independent desktop conversations fall outside this meter. Pairing and chat history carry over when upgrading the server and installed Android client.

### Change a job from the main conversation

Send the original request and any change of scope in the same phone conversation. For example, a catalog can have a print assignment and a digital assignment. Sending “Pause the digital edition and continue the print edition” updates the goal and acceptance criteria on the existing work order. Its card shows the responsible device and agent, elapsed time, and whether a withdrawal is pending, the worker confirmed a stop, or the task was withdrawn before pickup. Each parallel worker receives its own assignment. The router can cite a stopped assignment’s receipt when reporting its status. A late digital result is excluded from the revised delivery.

The router keeps one transcript. Its DeepSeek Harness planner runs each inference with durable session storage disabled. Each work order records its goal, revisions, assignment IDs and receipts. External agent sessions can be linked to a work order. An update delivered to a linked desktop session still asks for an acknowledgment only. The phone can continue issuing work while that session waits for its user.

After receiving results, the router checks the current acceptance criteria. It can request up to two additional assignments per order to address gaps, across all revisions combined. It may use remaining participants and their permitted modes. Write access for an adaptive step requires an active assignment authorized for writing in the current revision. A scope change can also explicitly authorize a fresh assignment. Worker restarts and late receipts are reconciled by assignment ID.

The hub creates the new revision and receipt fields on startup. Existing orders start at revision zero. Older receipts preserve the available execution history and may lack a worker-confirmed stop. Upgrade the hub and install the rebuilt Android app over the existing build to show revised goals and task cards.

### Continue linked work on a desktop

On the phone, open a device's agent, choose a session and select **接着聊**. Later phone messages keep the same work binding, including after an Android restart. **加入当前工作** adds another explicitly chosen session. **退出接续** sends subsequent mobile messages to ordinary chat. New replies in the participating desktop session appear in mobile chat with their origin. Updating the Android client requires rebuilding and installing the APK. Existing pairing and earlier chat remain usable.

Install the context connector described above on each participating device. A top-level desktop chat originally created through the desktop thread tool can be included by placing its exact ID in the connector configuration's optional `includedDesktopThreadIds` array. The local connector also reads `$ASTERHELM_HOME/context-local.json` when started without a configuration argument.

The stock Codex client can look up linked decisions on the next prompt. Register the repository's `server/mcp.mjs` as a local Codex MCP server. Register `node /absolute/path/to/server/work-context.mjs` as a trusted synchronous command hook for `UserPromptSubmit` and optionally `SessionStart` on resume. Use absolute paths to your Node 24 executable and repository, and a short hook timeout such as three seconds. On a remote worker, set `ASTERHELM_WORKER_CONFIG` to that worker's private configuration for both processes. The hook gives the model a short-lived ticket scoped to the thread and authorized connector. The read-only `get_work_context` tool returns attributed work records. Codex hook trust and discovery are controlled by your desktop client. [Codex hook configuration](https://learn.chatgpt.com/docs/hooks)

To send a **receipt turn** before the user types, enable the option in the desktop connector's private configuration.

```json
{
  "codexContinuity": {
    "mode": "receipt-turn",
    "codexExecutable": "/absolute/path/to/codex",
    "guardCommand": "/absolute/path/to/node /absolute/path/to/server/receipt-guard.mjs"
  }
}
```

This mode runs the official `codex queue` command for the selected existing thread. The owning client drains its queue, including when an already-open idle app receives an update. Offline or unopened threads may receive it later. Each batch requests one acknowledgment with the thread's configured model. A durable local claim prevents retries from queueing a duplicate after an ambiguous result. The phone shows **已送达桌面** only after the connector verifies the exact original note and acknowledgment in a completed turn with no extra work items. An unexpected reply or a tool call leaves the delivery unconfirmed. The command does not resume the thread on a second server. [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference)

Receipt turns inherit the thread's tools. Register the exact `guardCommand` as a synchronous command hook for `UserPromptSubmit`, `PreToolUse`, and `Stop`, with no matcher. Give the guard the connector's Asterhelm state directory. For a custom receipt directory, set `ASTERHELM_RECEIPT_DIR` on the hook to the same path. Review and trust these three definitions in Codex. On desktop builds where **Settings → Hooks** is empty with a disabled reload button, open the local project folder first. The CLI also provides `/hooks` for review. [Codex hook configuration](https://learn.chatgpt.com/docs/hooks)

Before each new batch the connector queries the effective hook definitions for the original thread's working directory. The default holds the receipt if a guard is missing, disabled, or awaiting trust. Opening a thread or using a tool to prime it is unnecessary. The guard verifies the local claim and denies supported tool calls for that receipt turn. The next ordinary user prompt uses the session's normal permissions. Local hooks cover selected Codex tool paths. The native transcript check also rejects completed receipts that contain other actions. For an isolated test deployment, explicitly setting `requireGuard` to `false` skips guard discovery. [Codex hook coverage](https://learn.chatgpt.com/docs/hooks#tool-coverage)

A strictly passive note uses a separate client capability. In the tested stock Codex build, injecting items supplied model context without producing a visible transcript entry. Resuming an idle thread did not display a hook message before the next prompt. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

Clients that implement passive notes can configure `codexContinuity.socketPath` and `codexContinuity.noteWriter` in the worker's private configuration. The socket must be the public App Server Unix endpoint serving that native client. The local executable receives one JSON object on stdin with `operation: "putIfIdle"`, `socketPath`, `threadId`, `deliveryId` and `text`. It must atomically append one idempotent, model-visible and user-visible note to that idle original thread and return `{turnId,itemId}`. Asterhelm independently reads the matching visible thread item before acknowledging delivery. This release includes the verifier and connector contract. A compatible native note writer for stock Codex Desktop is not included.

### 主聊天的主动跟进

可以对星舵说“每次目录校对任务失败都提醒我”，也可以明确指定由哪个设备的 Agent 做只读复核。规则登记后，原消息带有条件、最近一次结果和控制按钮。日历规则使用登记时的时区。主机在线时手机可以离线；主机重启后会补读任务回执。会话活动和设备在线状态只能从已观测到的快照判断。

自己发现的事项使用单独的候选卡。星舵可以派一次只读查证。只有用户在主聊天中明确批准，才会建立或关联一件工作。有多个候选时，用对应卡片的“同意立项”。在卡片里也可以忽略或额外委托一次只读复查。

升级已有部署时先备份个人服务与队列的 SQLite 数据库，并更新总控和 Worker。隔离只读能力由新版 Worker 在心跳中声明；执行端缺少该能力时，任务卡会说明原因。自行配置的命令执行器只承接其既有任务。旧版一次性提醒与监视保留原有触发次数。
