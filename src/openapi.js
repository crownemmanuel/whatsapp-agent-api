export function buildOpenApiSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "WhatsApp API Gateway",
      version: "1.0.0",
      description:
        "A general-purpose WhatsApp API for agents. Search contacts and groups by name to get their IDs, then send messages (with optional attachments), read recent messages, and register webhooks that fire when messages arrive.",
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "Status", description: "Connection status" },
      { name: "Directory", description: "Find groups and contacts (and their IDs)" },
      { name: "Messages", description: "Send and read messages" },
	      { name: "Webhooks", description: "Register URLs that fire on incoming messages" },
	      { name: "Codex", description: "Route matching WhatsApp messages to Codex" },
	      { name: "Cron", description: "Run scheduled gateway jobs and Codex-driven automations" },
	    ],
    paths: {
      "/api/status": {
        get: {
          tags: ["Status"],
          summary: "Connection status",
          responses: { 200: jsonResponse("Current status", "Status") },
        },
      },
      "/api/groups": {
        get: {
          tags: ["Directory"],
          summary: "Search groups by name",
          description:
            "Returns groups you participate in. Use `q` to filter by name, then use the returned `id` to send or read messages.",
          parameters: [queryParam("q", "Filter by group name (substring match)"), limitParam()],
          responses: { 200: jsonArrayResponse("Matching groups", "Group") },
        },
      },
      "/api/contacts": {
        get: {
          tags: ["Directory"],
          summary: "Search contacts by name or number",
          description:
            "Returns known contacts. Use `q` to filter by name or phone number, then use the returned `id` to send messages.",
          parameters: [queryParam("q", "Filter by contact name or number"), limitParam()],
          responses: { 200: jsonArrayResponse("Matching contacts", "Contact") },
        },
      },
      "/api/contacts/resolve": {
        get: {
          tags: ["Directory"],
          summary: "Resolve a phone number to a WhatsApp JID",
          parameters: [
            {
              name: "number",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Phone number in international format, e.g. 14155550123",
            },
          ],
          responses: {
            200: jsonResponse("Resolved JID", "Contact"),
            400: jsonResponse("Not registered on WhatsApp", "Error"),
          },
        },
      },
      "/api/chats/{chatId}/messages": {
        get: {
          tags: ["Messages"],
          summary: "Read recent messages from a chat",
          description:
            "Returns recent messages buffered for the given chat (group JID `...@g.us` or contact JID `...@s.whatsapp.net`).",
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Group or contact JID",
            },
            limitParam(),
          ],
          responses: { 200: jsonArrayResponse("Recent messages", "Message") },
        },
      },
      "/api/chats/{chatId}/typing": {
        post: {
          tags: ["Messages"],
          summary: "Show or hide the typing indicator in a chat",
          description:
            'Sets the WhatsApp "typing…" presence for the chat. `composing` keeps the indicator alive (auto-refreshed) until `durationMs` elapses or you post `paused`. Useful for webhook-driven agents that want to signal work in progress before replying.',
          parameters: [
            {
              name: "chatId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Group or contact JID",
            },
          ],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TypingInput" },
                example: { state: "composing", durationMs: 30000 },
              },
            },
          },
          responses: {
            200: jsonResponse("Typing state updated", "TypingResult"),
            400: jsonResponse("Invalid request", "Error"),
          },
        },
      },
      "/api/messages": {
        post: {
          tags: ["Messages"],
          summary: "Send a text message",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SendText" },
                example: { to: "14155550123", text: "Hello from the API gateway" },
              },
            },
          },
          responses: {
            200: jsonResponse("Message sent", "SendResult"),
            400: jsonResponse("Invalid request", "Error"),
          },
        },
      },
      "/api/messages/media": {
        post: {
          tags: ["Messages"],
          summary: "Send a message with an attachment",
          description:
            "Send an image, video, audio, or document. Provide the media as `mediaUrl` (downloaded server-side) or `mediaBase64`.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SendMedia" },
                example: {
                  to: "123456789@g.us",
                  type: "image",
                  mediaUrl: "https://example.com/photo.jpg",
                  caption: "Check this out",
                },
              },
            },
          },
          responses: {
            200: jsonResponse("Message sent", "SendResult"),
            400: jsonResponse("Invalid request", "Error"),
          },
        },
      },
      "/api/webhooks": {
        get: {
          tags: ["Webhooks"],
          summary: "List webhooks",
          responses: { 200: jsonArrayResponse("Registered webhooks", "Webhook") },
        },
        post: {
          tags: ["Webhooks"],
          summary: "Register a webhook",
          description:
            "Fires an HTTP POST to `url` when a matching message arrives. Omit `chatId` to receive messages from all chats, or set it to a group/contact JID to scope it.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookInput" },
                example: { url: "https://my-agent.example.com/wa-hook", chatId: "123456789@g.us" },
              },
            },
          },
          responses: {
            201: jsonResponse("Webhook created", "Webhook"),
            400: jsonResponse("Invalid request", "Error"),
          },
        },
      },
      "/api/webhooks/{id}": {
        delete: {
          tags: ["Webhooks"],
          summary: "Delete a webhook",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: jsonResponse("Deleted", "Ok"), 404: jsonResponse("Not found", "Error") },
        },
      },
      "/api/codex/status": {
        get: {
          tags: ["Codex"],
          summary: "Codex agent status",
          responses: { 200: jsonResponse("Codex status", "CodexStatus") },
        },
      },
      "/api/codex/config": {
        get: {
          tags: ["Codex"],
          summary: "Get Codex agent config",
          responses: { 200: jsonResponse("Codex config", "CodexConfig") },
        },
        put: {
          tags: ["Codex"],
          summary: "Update Codex agent config",
          requestBody: jsonRequest("CodexConfig"),
          responses: { 200: jsonResponse("Updated config", "CodexConfig") },
        },
      },
      "/api/codex/rules": {
        get: {
          tags: ["Codex"],
          summary: "List Codex routing rules",
          responses: { 200: jsonArrayResponse("Codex rules", "CodexRule") },
        },
        post: {
          tags: ["Codex"],
          summary: "Create a Codex routing rule",
          requestBody: jsonRequest("CodexRule"),
          responses: { 201: jsonResponse("Created rule", "CodexRule") },
        },
      },
      "/api/codex/rules/{id}": {
        put: {
          tags: ["Codex"],
          summary: "Update a Codex routing rule",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonRequest("CodexRule"),
          responses: { 200: jsonResponse("Updated rule", "CodexRule"), 404: jsonResponse("Not found", "Error") },
        },
        delete: {
          tags: ["Codex"],
          summary: "Delete a Codex routing rule",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: jsonResponse("Deleted", "Ok"), 404: jsonResponse("Not found", "Error") },
        },
      },
      "/api/codex/memory": {
        get: {
          tags: ["Codex"],
          summary: "Read memory for a chat workspace",
          parameters: [
            { name: "chatId", in: "query", required: true, schema: { type: "string" } },
            { name: "chatName", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { 200: jsonResponse("Chat memory", "CodexMemory") },
        },
        put: {
          tags: ["Codex"],
          summary: "Write memory for a chat workspace",
          requestBody: jsonRequest("CodexMemoryInput"),
          responses: { 200: jsonResponse("Chat memory", "CodexMemory") },
        },
      },
	      "/api/codex/runs": {
	        get: {
	          tags: ["Codex"],
	          summary: "List recent Codex runs",
	          responses: { 200: jsonArrayResponse("Recent Codex runs", "CodexRun") },
	        },
	      },
	      "/api/cron/status": {
	        get: {
	          tags: ["Cron"],
	          summary: "Cron scheduler status",
	          responses: { 200: jsonResponse("Scheduler status", "CronStatus") },
	        },
	      },
	      "/api/cron/config": {
	        get: {
	          tags: ["Cron"],
	          summary: "Get cron scheduler config",
	          responses: { 200: jsonResponse("Cron config", "CronConfig") },
	        },
	        put: {
	          tags: ["Cron"],
	          summary: "Update cron scheduler config",
	          requestBody: jsonRequest("CronConfig"),
	          responses: { 200: jsonResponse("Updated cron config", "CronConfig") },
	        },
	      },
	      "/api/cron/jobs": {
	        get: {
	          tags: ["Cron"],
	          summary: "List cron jobs",
	          responses: { 200: jsonArrayResponse("Cron jobs", "CronJob") },
	        },
	        post: {
	          tags: ["Cron"],
	          summary: "Create a cron job",
	          requestBody: jsonRequest("CronJob"),
	          responses: { 201: jsonResponse("Created cron job", "CronJob") },
	        },
	      },
	      "/api/cron/jobs/{id}": {
	        get: {
	          tags: ["Cron"],
	          summary: "Get a cron job",
	          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
	          responses: { 200: jsonResponse("Cron job", "CronJob"), 404: jsonResponse("Not found", "Error") },
	        },
	        put: {
	          tags: ["Cron"],
	          summary: "Update a cron job",
	          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
	          requestBody: jsonRequest("CronJob"),
	          responses: { 200: jsonResponse("Updated cron job", "CronJob"), 404: jsonResponse("Not found", "Error") },
	        },
	        delete: {
	          tags: ["Cron"],
	          summary: "Delete a cron job",
	          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
	          responses: { 200: jsonResponse("Deleted", "Ok"), 404: jsonResponse("Not found", "Error") },
	        },
	      },
	      "/api/cron/jobs/{id}/run": {
	        post: {
	          tags: ["Cron"],
	          summary: "Run a cron job now",
	          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
	          responses: { 200: jsonResponse("Cron run", "CronRun") },
	        },
	      },
	      "/api/cron/jobs/{id}/memory": {
	        get: {
	          tags: ["Cron"],
	          summary: "Read cron job memory",
	          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
	          responses: { 200: jsonResponse("Cron memory", "CronMemory") },
	        },
	        put: {
	          tags: ["Cron"],
	          summary: "Write cron job memory",
	          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
	          requestBody: jsonRequest("CronMemory"),
	          responses: { 200: jsonResponse("Cron memory", "CronMemory") },
	        },
	      },
	      "/api/cron/runs": {
	        get: {
	          tags: ["Cron"],
	          summary: "List recent cron runs",
	          responses: { 200: jsonArrayResponse("Recent cron runs", "CronRun") },
	        },
	      },
	      "/api/cron/chat": {
	        post: {
	          tags: ["Cron"],
	          summary: "Ask Codex to review or change scheduler jobs",
	          requestBody: jsonRequest("CronChatRequest"),
	          responses: { 200: jsonResponse("Codex scheduler chat result", "CronChatResponse") },
	        },
	      },
	    },
    components: {
      schemas: {
        Status: {
          type: "object",
          properties: {
            connected: { type: "boolean" },
            user: { type: "object", nullable: true },
            groupCount: { type: "integer" },
            contactCount: { type: "integer" },
          },
        },
        Group: {
          type: "object",
          properties: {
            id: { type: "string", example: "123456789@g.us" },
            name: { type: "string", example: "Operations Team" },
            participantCount: { type: "integer", nullable: true },
          },
        },
        Contact: {
          type: "object",
          properties: {
            id: { type: "string", example: "14155550123@s.whatsapp.net" },
            name: { type: "string" },
            number: { type: "string", example: "14155550123" },
          },
        },
        Message: {
          type: "object",
          properties: {
            id: { type: "string" },
            chatId: { type: "string" },
            chatName: { type: "string" },
            isGroup: { type: "boolean" },
            sender: { type: "string" },
            senderId: { type: "string", nullable: true },
            text: { type: "string" },
            mediaType: { type: "string", nullable: true, enum: ["image", "video", "audio", "document", "sticker", null] },
            mediaUrl: { type: "string", nullable: true },
            hasMedia: { type: "boolean" },
            mentionedJids: { type: "array", items: { type: "string" } },
            fromMe: { type: "boolean" },
            ts: { type: "integer", description: "Unix epoch milliseconds" },
          },
        },
        SendText: {
          type: "object",
          required: ["to", "text"],
          properties: {
            to: {
              type: "string",
              description: "Group JID (...@g.us), contact JID (...@s.whatsapp.net), or a phone number",
            },
            text: { type: "string" },
          },
        },
        SendMedia: {
          type: "object",
          required: ["to", "type"],
          properties: {
            to: { type: "string", description: "Group JID, contact JID, or phone number" },
            type: { type: "string", enum: ["image", "video", "audio", "document"] },
            mediaUrl: { type: "string", description: "URL to download (alternative to mediaBase64)" },
            mediaBase64: { type: "string", description: "Base64-encoded media (alternative to mediaUrl)" },
            caption: { type: "string" },
            filename: { type: "string", description: "Used for document type" },
            mimetype: { type: "string" },
            ptt: { type: "boolean", description: "For audio: send as a voice note" },
          },
        },
        SendResult: {
          type: "object",
          properties: { id: { type: "string" }, to: { type: "string" } },
        },
        TypingInput: {
          type: "object",
          properties: {
            state: {
              type: "string",
              enum: ["composing", "paused"],
              default: "composing",
              description: "`composing` shows the typing indicator, `paused` hides it",
            },
            durationMs: {
              type: "integer",
              default: 30000,
              maximum: 300000,
              description: "How long to keep typing before auto-stopping (composing only, capped at 5 minutes)",
            },
          },
        },
        TypingResult: {
          type: "object",
          properties: {
            chatId: { type: "string", description: "Resolved chat JID" },
            state: { type: "string", enum: ["composing", "paused"] },
            durationMs: { type: "integer", description: "Effective auto-stop window (composing only)" },
          },
        },
        Webhook: {
          type: "object",
          properties: {
            id: { type: "string" },
            url: { type: "string" },
            chatId: { type: "string", nullable: true },
            events: { type: "array", items: { type: "string" } },
            secret: { type: "string" },
            enabled: { type: "boolean" },
            createdAt: { type: "string" },
          },
        },
        WebhookInput: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", description: "Endpoint to POST message events to" },
            chatId: { type: "string", description: "Optional group/contact JID to scope the webhook" },
            secret: { type: "string", description: "Sent back as the X-Webhook-Secret header" },
            events: { type: "array", items: { type: "string" }, default: ["message"] },
          },
        },
        CodexStatus: {
          type: "object",
          properties: {
            ready: { type: "boolean" },
            sdkInstalled: { type: "boolean" },
            cliAvailable: { type: "boolean" },
            cliPath: { type: "string" },
            cliVersion: { type: "string" },
            enabled: { type: "boolean" },
            ruleCount: { type: "integer" },
            workspaceRoot: { type: "string" },
            installCommand: { type: "string" },
            notes: { type: "array", items: { type: "string" } },
            recentRuns: { type: "array", items: { $ref: "#/components/schemas/CodexRun" } },
          },
        },
        CodexConfig: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            model: { type: "string" },
            defaultSandbox: { type: "string", enum: ["read-only", "workspace-write", "full-access"] },
            approvalPolicy: { type: "string", enum: ["never", "on-request", "on-failure", "untrusted"] },
            autoReply: { type: "boolean" },
            replyOnError: { type: "boolean" },
            networkAccessEnabled: { type: "boolean" },
            workspaceRoot: { type: "string" },
            defaultPrompt: { type: "string" },
            rules: { type: "array", items: { $ref: "#/components/schemas/CodexRule" } },
          },
        },
        CodexRule: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            enabled: { type: "boolean" },
            chatType: { type: "string", enum: ["all", "group", "dm"] },
            chatId: { type: "string", nullable: true },
            allowedSenderIds: { type: "array", items: { type: "string" } },
            keywords: { type: "array", items: { type: "string" } },
            requireMention: { type: "boolean" },
            allowFromMe: { type: "boolean" },
            sandbox: { type: "string", enum: ["read-only", "workspace-write", "full-access"] },
            autoReply: { type: "boolean", nullable: true },
            model: { type: "string" },
            prompt: { type: "string" },
            workspaceSubdir: { type: "string" },
            createdAt: { type: "string" },
          },
        },
        CodexMemoryInput: {
          type: "object",
          required: ["chatId", "text"],
          properties: {
            chatId: { type: "string" },
            chatName: { type: "string" },
            isGroup: { type: "boolean" },
            text: { type: "string" },
          },
        },
        CodexMemory: {
          type: "object",
          properties: {
            workspaceName: { type: "string" },
            workspaceDir: { type: "string" },
            text: { type: "string" },
          },
        },
	        CodexRun: {
	          type: "object",
	          properties: {
            id: { type: "string" },
            ruleId: { type: "string" },
            ruleName: { type: "string" },
            chatId: { type: "string" },
            chatName: { type: "string" },
            senderId: { type: "string" },
            startedAt: { type: "string" },
            finishedAt: { type: "string", nullable: true },
            ok: { type: "boolean" },
            error: { type: "string" },
            response: { type: "string" },
            workspaceDir: { type: "string" },
	            threadId: { type: "string" },
	          },
	        },
	        CronConfig: {
	          type: "object",
	          properties: {
	            enabled: { type: "boolean" },
	            defaultTimezone: { type: "string", example: "America/New_York" },
	            jobs: { type: "array", items: { $ref: "#/components/schemas/CronJob" } },
	          },
	        },
	        CronStatus: {
	          type: "object",
	          properties: {
	            enabled: { type: "boolean" },
	            defaultTimezone: { type: "string" },
	            jobCount: { type: "integer" },
	            runningJobIds: { type: "array", items: { type: "string" } },
	            rootDir: { type: "string" },
	            jobs: { type: "array", items: { $ref: "#/components/schemas/CronJobSummary" } },
	            recentRuns: { type: "array", items: { $ref: "#/components/schemas/CronRun" } },
	            codex: { $ref: "#/components/schemas/CodexStatus" },
	          },
	        },
	        CronJobSummary: {
	          type: "object",
	          properties: {
	            id: { type: "string" },
	            name: { type: "string" },
	            enabled: { type: "boolean" },
	            schedule: { type: "object" },
	            previewOnly: { type: "boolean" },
	            allowOverlap: { type: "boolean" },
	            stepCount: { type: "integer" },
	            lastRunAt: { type: "string" },
	            nextRunAt: { type: "string" },
	          },
	        },
	        CronJob: {
	          type: "object",
	          properties: {
	            id: { type: "string", example: "birthdays" },
	            name: { type: "string", example: "Daily birthdays" },
	            enabled: { type: "boolean" },
	            description: { type: "string" },
	            schedule: {
	              type: "object",
	              properties: {
	                mode: { type: "string", enum: ["cron"], default: "cron" },
	                expression: { type: "string", example: "0 6 * * *" },
	                timezone: { type: "string", example: "America/New_York" },
	              },
	            },
	            previewOnly: { type: "boolean", description: "Dry-run WhatsApp sends when true" },
	            allowOverlap: { type: "boolean" },
	            workspaceSubdir: { type: "string" },
	            env: {
	              type: "object",
	              additionalProperties: { type: "string" },
	              description: "Map template aliases to environment variable names; secret values are never stored here.",
	              example: { API_KEY: "BIRTHDAY_API_KEY" },
	            },
	            steps: { type: "array", items: { $ref: "#/components/schemas/CronStep" } },
	          },
	        },
	        CronStep: {
	          type: "object",
	          properties: {
	            id: { type: "string" },
	            type: { type: "string", enum: ["http", "transform", "script", "codex", "whatsapp"] },
	            saveAs: { type: "string" },
	            continueOnError: { type: "boolean" },
	          },
	          additionalProperties: true,
	        },
	        CronRun: {
	          type: "object",
	          properties: {
	            id: { type: "string" },
	            jobId: { type: "string" },
	            jobName: { type: "string" },
	            trigger: { type: "string" },
	            startedAt: { type: "string" },
	            finishedAt: { type: "string", nullable: true },
	            ok: { type: "boolean" },
	            previewOnly: { type: "boolean" },
	            workspaceDir: { type: "string" },
	            steps: { type: "array", items: { type: "object" } },
	            outputs: { type: "object" },
	            error: { type: "string" },
	          },
	        },
	        CronMemory: {
	          type: "object",
	          properties: {
	            workspaceDir: { type: "string" },
	            text: { type: "string" },
	          },
	        },
	        CronChatRequest: {
	          type: "object",
	          required: ["message"],
	          properties: {
	            message: {
	              type: "string",
	              example: "Create a weekday 6 AM job that calls the birthday API, asks Codex to draft copy, and sends the result to the media group.",
	            },
	          },
	        },
	        CronChatResponse: {
	          type: "object",
	          properties: {
	            ok: { type: "boolean" },
	            changed: { type: "boolean" },
	            message: { type: "string" },
	            operation: { type: "object" },
	            applied: { type: "object" },
	            finalResponse: { type: "string" },
	          },
	        },
	        Ok: { type: "object", properties: { ok: { type: "boolean" } } },
        Error: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }
}

function queryParam(name, description) {
  return { name, in: "query", required: false, schema: { type: "string" }, description }
}

function limitParam() {
  return {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", default: 50 },
    description: "Maximum number of results",
  }
}

function jsonResponse(description, schema) {
  return {
    description,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  }
}

function jsonRequest(schema) {
  return {
    required: true,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  }
}

function jsonArrayResponse(description, schema) {
  return {
    description,
    content: {
      "application/json": { schema: { type: "array", items: { $ref: `#/components/schemas/${schema}` } } },
    },
  }
}

export function renderSwaggerHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp API Gateway — Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; }
    .topbar { display: none; }
    #nav {
      background: #111b21; color: #e9edef; padding: 10px 18px;
      font-family: "Segoe UI", system-ui, sans-serif; display: flex; gap: 16px; align-items: center;
    }
    #nav b { color: #25d366; }
    #nav a { color: #8696a0; text-decoration: none; font-size: .9rem; }
    #nav a:hover { color: #e9edef; }
  </style>
</head>
<body>
  <div id="nav"><b>WhatsApp API Gateway</b><span>API documentation</span>
    <a href="/ui" style="margin-left:auto;">Management UI →</a>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`
}

export function renderManagementHtml() {
  const icon = (paths) =>
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    paths +
    "</svg>"
  const icons = {
    chat: icon('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>'),
    users: icon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    user: icon('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    zap: icon('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    bot: icon('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
    sliders: icon('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
    route: icon('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
    folder: icon('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    memory: icon('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'),
	    activity: icon('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
	    book: icon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
	    clock: icon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
	  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp API Gateway</title>
  <style>
    :root {
      --bg:#0a1014; --panel:#121d24; --panel2:#1a2730; --inset:#0c151b;
      --line:#243340; --line-soft:rgba(134,150,160,.14);
      --text:#e9edef; --muted:#8696a0; --accent:#25d366;
      --accent-soft:rgba(37,211,102,.12); --danger:#ff6b81;
      --radius:16px; --radius-sm:10px;
      --shadow:0 12px 32px rgba(0,0,0,.38), 0 2px 8px rgba(0,0,0,.28);
      --shadow-soft:0 6px 18px rgba(0,0,0,.26);
    }
    * { box-sizing: border-box; }
    html { background:var(--bg); }
    body { margin:0; min-height:100vh; color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif; background:radial-gradient(1200px 520px at 80% -10%, #142630 0%, rgba(10,16,20,0) 58%) no-repeat; }
    .icon { width:16px; height:16px; flex:none; }
    header { position:sticky; top:0; z-index:50; background:rgba(18,29,36,.85); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border-bottom:1px solid var(--line); padding:12px 24px; display:flex; align-items:center; gap:12px; }
    .logo { width:34px; height:34px; border-radius:10px; background:linear-gradient(135deg,var(--accent),#128c7e); display:flex; align-items:center; justify-content:center; color:#062e1c; box-shadow:var(--shadow-soft); }
    .logo .icon { width:18px; height:18px; }
    header h1 { font-size:1.02rem; margin:0; font-weight:600; letter-spacing:.01em; }
    header h1 b { color:var(--accent); font-weight:700; }
    .header-right { margin-left:auto; display:flex; align-items:center; gap:12px; }
    header .status { display:inline-flex; align-items:center; gap:7px; font-size:.82rem; color:var(--muted); background:var(--panel2); border:1px solid var(--line); border-radius:999px; padding:6px 12px; white-space:nowrap; }
    header .status::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--muted); }
    header .status.ok { color:var(--accent); border-color:rgba(37,211,102,.35); background:var(--accent-soft); }
    header .status.ok::before { background:var(--accent); box-shadow:0 0 8px var(--accent); }
    header a { display:inline-flex; align-items:center; gap:6px; color:var(--muted); text-decoration:none; font-size:.88rem; padding:7px 11px; border-radius:9px; transition:color .15s, background .15s; }
    header a:hover { color:var(--text); background:var(--panel2); }
    .tabs { display:flex; gap:4px; padding:18px 24px 0; max-width:1280px; margin:0 auto; width:100%; }
    .tabs button { display:inline-flex; align-items:center; gap:8px; background:transparent; border:1px solid transparent; color:var(--muted); padding:9px 16px; cursor:pointer; border-radius:999px; font-size:.92rem; font-weight:500; font-family:inherit; transition:color .15s, background .15s, border-color .15s; }
    .tabs button:hover { color:var(--text); background:var(--panel2); }
    .tabs button.active { color:var(--accent); background:var(--accent-soft); border-color:rgba(37,211,102,.3); }
    .tabs .icon { width:15px; height:15px; }
    main { padding:18px 24px 56px; max-width:1280px; margin:0 auto; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:22px; box-shadow:var(--shadow); }
    input, select, textarea { background:var(--inset); border:1px solid var(--line); color:var(--text); border-radius:var(--radius-sm); padding:10px 12px; font-size:.92rem; width:100%; font-family:inherit; transition:border-color .15s, box-shadow .15s; }
    input:focus, select:focus, textarea:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
    input::placeholder, textarea::placeholder { color:#5d6c75; }
    textarea { min-height:86px; resize:vertical; line-height:1.4; }
    input[type="checkbox"] { width:16px; height:16px; accent-color:var(--accent); cursor:pointer; flex:none; }
    .search { margin-bottom:16px; max-width:420px; }
    table { width:100%; border-collapse:collapse; font-size:.9rem; }
    th, td { text-align:left; padding:11px 10px; border-bottom:1px solid var(--line-soft); }
    th { color:var(--muted); font-weight:600; font-size:.73rem; text-transform:uppercase; letter-spacing:.07em; }
    tbody tr { transition:background .12s; }
    tbody tr:hover { background:rgba(134,150,160,.05); }
    tbody tr:last-child td { border-bottom:none; }
    .id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem; color:var(--muted); }
    .copy { background:var(--panel2); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:5px 10px; cursor:pointer; font-size:.78rem; font-family:inherit; transition:border-color .15s, color .15s; }
    .copy:hover { border-color:var(--accent); color:var(--accent); }
    .muted { color:var(--muted); }
    .hidden { display:none; }
    form.wh { display:grid; gap:10px; max-width:560px; margin-bottom:22px; }
    form.wh label, .field label { font-size:.83rem; color:var(--muted); font-weight:500; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
    .grid.three { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .field { display:grid; gap:6px; align-content:start; }
    .span2 { grid-column:span 2; }
    .bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
    .bar .grow { flex:1; min-width:220px; }
    .checkline { display:flex; align-items:center; gap:9px; color:var(--muted); font-size:.9rem; cursor:pointer; }
    .badge { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--panel2); color:var(--muted); border-radius:999px; padding:5px 11px; font-size:.78rem; font-weight:500; }
    .badge::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--muted); }
    .badge.ok { color:var(--accent); border-color:rgba(37,211,102,.35); background:var(--accent-soft); }
    .badge.ok::before { background:var(--accent); }
    .split { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(320px,.8fr); gap:18px; align-items:start; }
    button.primary { display:inline-flex; align-items:center; gap:8px; background:var(--accent); color:#08240f; border:none; border-radius:var(--radius-sm); padding:10px 18px; font-weight:600; font-size:.9rem; font-family:inherit; cursor:pointer; justify-self:start; box-shadow:0 2px 10px rgba(37,211,102,.25); transition:filter .15s, transform .1s, box-shadow .15s; }
    button.primary:hover { filter:brightness(1.07); box-shadow:0 4px 14px rgba(37,211,102,.35); }
    button.primary:active { transform:translateY(1px); }
    button.secondary { background:var(--panel2); border:1px solid var(--line); color:var(--text); border-radius:var(--radius-sm); padding:9px 14px; font-size:.88rem; font-family:inherit; cursor:pointer; transition:border-color .15s, background .15s; }
    button.secondary:hover { border-color:var(--accent); }
    button.del { background:transparent; border:1px solid rgba(255,107,129,.35); color:var(--danger); border-radius:8px; padding:5px 11px; cursor:pointer; font-size:.78rem; font-family:inherit; transition:background .15s, border-color .15s; }
    button.del:hover { background:rgba(255,107,129,.12); border-color:var(--danger); }
    button.edit { background:var(--panel2); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:5px 11px; cursor:pointer; font-size:.78rem; font-family:inherit; margin-right:6px; transition:border-color .15s, color .15s; }
    button.edit:hover { border-color:var(--accent); color:var(--accent); }
    .combo { position:relative; }
    .combo-trigger { position:relative; display:block; background:var(--inset); border:1px solid var(--line); color:var(--text); border-radius:var(--radius-sm); padding:10px 34px 10px 12px; font-size:.92rem; font-family:inherit; width:100%; text-align:left; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; transition:border-color .15s, box-shadow .15s; }
    .combo-trigger::after { content:""; position:absolute; right:14px; top:50%; width:7px; height:7px; border-right:2px solid var(--muted); border-bottom:2px solid var(--muted); transform:translateY(-70%) rotate(45deg); transition:transform .15s; }
    .combo-trigger:hover { border-color:var(--accent); }
    .combo-trigger.open { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
    .combo-trigger.open::after { transform:translateY(-30%) rotate(225deg); }
    .combo-menu { position:absolute; z-index:30; left:0; right:0; top:calc(100% + 6px); background:var(--panel2); border:1px solid var(--line); border-radius:12px; max-height:300px; display:flex; flex-direction:column; overflow:hidden; box-shadow:var(--shadow); }
    .combo-menu.hidden { display:none; }
    .combo-search { background:var(--inset); border:none; border-bottom:1px solid var(--line); border-radius:0; padding:11px 13px; }
    .combo-search:focus { outline:none; box-shadow:none; border-bottom-color:var(--accent); }
    .combo-options { overflow-y:auto; overscroll-behavior:contain; }
    .combo-option { display:flex; flex-direction:column; align-items:flex-start; gap:2px; width:100%; background:transparent; border:none; border-bottom:1px solid var(--line-soft); color:var(--text); font-family:inherit; font-size:.9rem; text-align:left; padding:10px 13px; cursor:pointer; transition:background .12s; }
    .combo-option:last-child { border-bottom:none; }
    .combo-option:hover { background:rgba(134,150,160,.08); }
    .combo-option.active { background:var(--accent-soft); box-shadow:inset 3px 0 0 var(--accent); }
    .combo-option .id { display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .combo-options::-webkit-scrollbar { width:8px; }
    .combo-options::-webkit-scrollbar-thumb { background:var(--line); border-radius:4px; }
    .combo-options::-webkit-scrollbar-thumb:hover { background:var(--muted); }
    .rule-actions { display:flex; gap:6px; flex-wrap:wrap; }
    .rule-form-actions { display:flex; gap:8px; align-items:center; }
    .codex-card { background:var(--panel2); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin-bottom:16px; box-shadow:var(--shadow-soft); }
    .codex-card h2, .panel > h2 { display:flex; align-items:center; gap:9px; font-size:.95rem; margin:0 0 6px; font-weight:600; }
    .codex-card h2 .icon, .panel > h2 .icon { color:var(--accent); }
    .panel > h2 { margin-bottom:14px; }
    .section-help { font-size:.82rem; color:var(--muted); margin:0 0 14px; line-height:1.5; }
    .field-help { font-size:.77rem; color:var(--muted); line-height:1.4; }
    .codex-master { display:flex; gap:12px; align-items:flex-start; cursor:pointer; }
    .codex-master input { margin-top:3px; }
    .codex-master strong { display:block; margin-bottom:4px; }
	    .info-box { background:var(--inset); border:1px solid var(--line); border-radius:var(--radius-sm); padding:11px 13px; font-size:.82rem; }
	    .info-box .id { display:block; margin-top:4px; word-break:break-all; }
	    .mono-area { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.82rem; min-height:150px; }
	    .job-list { display:grid; gap:10px; margin-top:12px; }
	    .job-card { background:var(--inset); border:1px solid var(--line); border-radius:12px; padding:13px; display:grid; gap:9px; }
	    .job-card-head { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
	    .job-card h3 { margin:0; font-size:.95rem; font-weight:600; }
	    .job-meta { display:flex; flex-wrap:wrap; gap:6px; }
	    .schedule-builder { background:var(--inset); border:1px solid var(--line); border-radius:12px; padding:13px; display:grid; gap:12px; }
	    .schedule-row { display:grid; grid-template-columns:minmax(0,1fr) 150px minmax(120px,170px); gap:12px; align-items:end; }
	    .weekday-picker { display:flex; gap:6px; flex-wrap:wrap; }
	    .weekday-chip { background:var(--panel2); border:1px solid var(--line); color:var(--muted); border-radius:999px; min-width:42px; height:34px; padding:0 11px; cursor:pointer; font-size:.78rem; font-weight:600; font-family:inherit; transition:background .15s, color .15s, border-color .15s; }
	    .weekday-chip:hover { color:var(--text); border-color:rgba(37,211,102,.45); }
	    .weekday-chip.active { color:#08240f; background:var(--accent); border-color:var(--accent); }
	    .schedule-summary { border-top:1px solid var(--line-soft); padding-top:10px; color:var(--muted); font-size:.86rem; }
	    .chat-log { background:var(--inset); border:1px solid var(--line); border-radius:12px; padding:12px; min-height:96px; max-height:260px; overflow:auto; font-size:.86rem; line-height:1.45; white-space:pre-wrap; }
	    .run-log { max-height:330px; overflow:auto; }
	    @media (max-width: 880px) { .grid, .grid.three, .split, .schedule-row { grid-template-columns:1fr; } .span2 { grid-column:auto; } main, .tabs { padding-left:14px; padding-right:14px; } }
    .toast { position:fixed; bottom:24px; left:50%; transform:translate(-50%, 8px); background:var(--panel2); border:1px solid rgba(37,211,102,.4); color:var(--text); padding:11px 20px; border-radius:12px; font-size:.9rem; box-shadow:var(--shadow); opacity:0; pointer-events:none; transition:opacity .2s, transform .2s; }
    .toast.show { opacity:1; transform:translate(-50%, 0); }
  </style>
</head>
<body>
  <header>
    <div class="logo">${icons.chat}</div>
    <h1><b>WhatsApp</b> API Gateway</h1>
    <div class="header-right">
      <a href="/docs">${icons.book} API Docs</a>
      <span id="status" class="status">connecting…</span>
    </div>
  </header>
  <div class="tabs">
    <button data-tab="groups" class="active">${icons.users} Groups</button>
	    <button data-tab="contacts">${icons.user} Contacts</button>
	    <button data-tab="webhooks">${icons.zap} Webhooks</button>
	    <button data-tab="cron">${icons.clock} Cron</button>
	    <button data-tab="codex">${icons.bot} Codex</button>
	  </div>
  <main>
    <section id="tab-groups" class="panel">
      <h2>${icons.users} Groups</h2>
      <input id="group-search" class="search" placeholder="Search groups by name…">
      <table><thead><tr><th>Name</th><th>ID</th><th>Members</th><th></th></tr></thead><tbody id="group-rows"></tbody></table>
    </section>

    <section id="tab-contacts" class="panel hidden">
      <h2>${icons.user} Contacts</h2>
      <input id="contact-search" class="search" placeholder="Search contacts by name or number…">
      <table><thead><tr><th>Name</th><th>Number</th><th>ID</th><th></th></tr></thead><tbody id="contact-rows"></tbody></table>
    </section>

	    <section id="tab-webhooks" class="panel hidden">
	      <h2>${icons.zap} Webhooks</h2>
	      <form class="wh" id="wh-form">
        <label>Webhook URL (POST target)</label>
        <input id="wh-url" placeholder="https://my-agent.example.com/wa-hook" required>
        <label>Scope to chat ID (optional — blank = all chats)</label>
        <input id="wh-chat" placeholder="123456789@g.us">
        <label>Secret header (optional)</label>
        <input id="wh-secret" placeholder="sent as X-Webhook-Secret">
        <button class="primary" type="submit">Add Webhook</button>
      </form>
	      <table><thead><tr><th>URL</th><th>Chat</th><th>Created</th><th></th></tr></thead><tbody id="wh-rows"></tbody></table>
	    </section>

	    <section id="tab-cron" class="panel hidden">
	      <div class="bar">
	        <span id="cron-enabled-badge" class="badge">scheduler off</span>
	        <span id="cron-codex-badge" class="badge">checking Codex</span>
	        <span id="cron-root" class="muted grow"></span>
	        <button id="cron-refresh" class="secondary" type="button">Refresh</button>
	      </div>

	      <div class="split">
	        <div>
	          <div class="codex-card">
	            <h2>${icons.clock} Scheduler</h2>
	            <form id="cron-config-form" class="grid">
	              <label class="checkline"><input id="cron-enabled" type="checkbox"> Enabled</label>
	              <div class="field">
	                <label>Default timezone</label>
	                <input id="cron-timezone" placeholder="America/New_York">
	              </div>
	              <button class="primary" type="submit">Save scheduler</button>
	            </form>
	          </div>

	          <div class="codex-card">
	            <h2>${icons.sliders} Job editor</h2>
	            <form id="cron-job-form" class="grid">
	              <div class="field">
	                <label>Name</label>
	                <input id="cron-job-name" placeholder="Daily birthdays" required>
	              </div>
	              <div class="field">
	                <label>ID</label>
	                <input id="cron-job-id" placeholder="daily-birthdays">
	              </div>
	              <div class="field">
	                <label>Cron expression</label>
	                <input id="cron-expression" placeholder="0 6 * * *" required>
	              </div>
		              <div class="field">
		                <label>Timezone</label>
		                <input id="cron-job-timezone" placeholder="America/New_York">
		              </div>
		              <div class="schedule-builder span2">
		                <div class="schedule-row">
		                  <div class="field">
		                    <label>Visual schedule</label>
		                    <select id="cron-schedule-mode">
		                      <option value="daily">Every day</option>
		                      <option value="weekdays">Weekdays</option>
		                      <option value="weekly">Selected weekdays</option>
		                      <option value="monthly">Monthly</option>
		                      <option value="custom">Custom cron</option>
		                    </select>
		                  </div>
		                  <div class="field">
		                    <label>Time</label>
		                    <input id="cron-schedule-time" type="time" value="06:00">
		                  </div>
		                  <div class="field hidden" id="cron-monthday-field">
		                    <label>Day</label>
		                    <input id="cron-monthday" type="number" min="1" max="31" value="1">
		                  </div>
		                </div>
		                <div class="field hidden" id="cron-weekday-field">
		                  <label>Days</label>
		                  <div class="weekday-picker">
		                    <button type="button" class="weekday-chip" data-day="1">Mon</button>
		                    <button type="button" class="weekday-chip" data-day="2">Tue</button>
		                    <button type="button" class="weekday-chip" data-day="3">Wed</button>
		                    <button type="button" class="weekday-chip" data-day="4">Thu</button>
		                    <button type="button" class="weekday-chip" data-day="5">Fri</button>
		                    <button type="button" class="weekday-chip" data-day="6">Sat</button>
		                    <button type="button" class="weekday-chip" data-day="0">Sun</button>
		                  </div>
		                </div>
		                <div class="schedule-summary" id="cron-schedule-summary">Every day at 6:00 AM.</div>
		              </div>
		              <label class="checkline"><input id="cron-job-enabled" type="checkbox" checked> Job enabled</label>
	              <label class="checkline"><input id="cron-preview-only" type="checkbox"> Preview only</label>
	              <label class="checkline"><input id="cron-allow-overlap" type="checkbox"> Allow overlap</label>
	              <div></div>
	              <div class="field span2">
	                <label>Env aliases JSON</label>
	                <textarea id="cron-env" class="mono-area" spellcheck="false"></textarea>
	              </div>
	              <div class="field span2">
	                <label>Steps JSON</label>
	                <textarea id="cron-steps" class="mono-area" spellcheck="false"></textarea>
	              </div>
	              <div class="rule-form-actions span2">
	                <button class="primary" type="submit" id="cron-submit-btn">Add job</button>
	                <button class="secondary hidden" type="button" id="cron-cancel-btn">Cancel</button>
	              </div>
	            </form>
	          </div>

	          <div class="codex-card">
	            <h2>${icons.route} Jobs</h2>
	            <div id="cron-job-list" class="job-list"></div>
	          </div>
	        </div>

	        <div>
	          <div class="codex-card">
	            <h2>${icons.bot} Scheduler chat</h2>
	            <form id="cron-chat-form" class="field">
	              <label>Message Codex</label>
	              <textarea id="cron-chat-message" placeholder="Set up a weekday 6 AM job that pulls birthdays and sends a WhatsApp draft"></textarea>
	              <button class="primary" type="submit">Ask Codex</button>
	            </form>
	            <div id="cron-chat-log" class="chat-log muted">No scheduler chat yet.</div>
	          </div>

	          <div class="codex-card">
	            <h2>${icons.memory} Job memory</h2>
	            <form id="cron-memory-form" class="field">
	              <label>Job</label>
	              <select id="cron-memory-job"></select>
	              <label>Memory notes</label>
	              <textarea id="cron-memory-text" class="mono-area" placeholder="Load a job first"></textarea>
	              <div class="bar">
	                <button id="cron-memory-load" class="secondary" type="button">Load memory</button>
	                <button class="primary" type="submit">Save memory</button>
	              </div>
	            </form>
	          </div>

	          <div class="codex-card">
	            <h2>${icons.activity} Recent runs</h2>
	            <div class="run-log">
	              <table><thead><tr><th>Run</th><th>Status</th></tr></thead><tbody id="cron-run-rows"></tbody></table>
	            </div>
	          </div>
	        </div>
	      </div>
	    </section>

	    <section id="tab-codex" class="panel hidden">
      <div class="bar">
        <span id="codex-ready" class="badge">checking</span>
        <span id="codex-routing-badge" class="badge">routing off</span>
        <span id="codex-install-note" class="muted grow hidden"></span>
        <button id="codex-refresh" class="secondary" type="button">Refresh</button>
      </div>

      <div class="codex-card">
        <label class="codex-master">
          <input id="codex-enabled" type="checkbox">
          <div>
            <strong>Enable Codex routing</strong>
            <p class="section-help" style="margin:0;">Rules only run when this is on. Save is automatic when you toggle.</p>
          </div>
        </label>
      </div>

      <p id="codex-disabled-note" class="section-help">Codex routing is off. Turn it on above to add rules, memory, and activity.</p>

      <div id="codex-active-panel" class="hidden">
        <div class="split">
          <div>
            <div class="codex-card">
              <h2>${icons.sliders} Global defaults</h2>
              <p class="section-help">Shared settings for every rule. Individual rules can override sandbox, auto-reply, and prompt.</p>
              <form id="codex-config-form" class="grid">
                <div class="field">
                  <label>Default sandbox</label>
                  <select id="codex-default-sandbox">
                    <option value="full-access">Full access</option>
                    <option value="workspace-write">Workspace write</option>
                    <option value="read-only">Read only</option>
                  </select>
                  <span class="field-help">Used when a rule leaves sandbox unset.</span>
                </div>
                <div class="field">
                  <label>Model override</label>
                  <input id="codex-model" placeholder="blank = Codex default">
                  <span class="field-help">Optional model for all rules.</span>
                </div>
                <label class="checkline"><input id="codex-auto-reply" type="checkbox"> Auto-reply to WhatsApp</label>
                <label class="checkline"><input id="codex-network" type="checkbox"> Network access</label>
                <div class="field span2">
                  <label>Global prompt</label>
                  <textarea id="codex-default-prompt"></textarea>
                  <span class="field-help">Base instructions for every Codex run. Each rule can add extra instructions below.</span>
                </div>
                <div class="field span2">
                  <label>Workspace root (advanced)</label>
                  <input id="codex-workspace-root" placeholder="blank = data/codex-workspaces">
                  <span class="field-help">Base folder where per-chat workspaces are created. Usually leave blank.</span>
                </div>
                <button class="primary" type="submit">Save global defaults</button>
              </form>
            </div>

            <div class="codex-card">
              <h2>${icons.route} Routing rules</h2>
              <p class="section-help">Decide which WhatsApp messages trigger Codex. First matching rule wins.</p>
              <form id="codex-rule-form" class="grid three">
                <div class="field">
                  <label>Rule name</label>
                  <input id="rule-name" placeholder="Ops mentions" required>
                </div>
                <div class="field">
                  <label>Chat type</label>
                  <select id="rule-chat-type">
                    <option value="group">Group</option>
                    <option value="dm">DM</option>
                    <option value="all">All</option>
                  </select>
                </div>
                <div class="field">
                  <label>Sandbox override</label>
                  <select id="rule-sandbox">
                    <option value="full-access">Full access</option>
                    <option value="workspace-write">Workspace write</option>
                    <option value="read-only">Read only</option>
                  </select>
                </div>
                <div class="field span2">
                  <label>Limit to chat</label>
                  <div class="combo" id="rule-chat-combo">
                    <button type="button" class="combo-trigger" id="rule-chat-trigger">Any matching chat</button>
                    <div class="combo-menu hidden" id="rule-chat-menu">
                      <input type="text" class="combo-search" id="rule-chat-search" placeholder="Search groups and contacts…" autocomplete="off">
                      <div class="combo-options" id="rule-chat-options"></div>
                    </div>
                    <input type="hidden" id="rule-chat-id" value="">
                  </div>
                  <span class="field-help">Pick a group or contact, or leave as any matching chat.</span>
                </div>
                <div class="field">
                  <label class="checkline"><input id="rule-require-mention" type="checkbox"> Require @ me</label>
                  <label class="checkline"><input id="rule-allow-from-me" type="checkbox"> Allow my messages</label>
                  <span class="field-help">Your messages need a keyword (defaults to codex). Agent replies are ignored.</span>
                </div>
                <div class="field">
                  <label>Allowed senders</label>
                  <textarea id="rule-senders" placeholder="one phone per line (blank = anyone)"></textarea>
                </div>
                <div class="field">
                  <label>Keywords</label>
                  <textarea id="rule-keywords" placeholder="one keyword per line (blank = any text)"></textarea>
                </div>
                <div class="field">
                  <label>Auto-reply override</label>
                  <select id="rule-auto-reply">
                    <option value="">Use global default</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
                <div class="field span2">
                  <label>Extra rule prompt</label>
                  <textarea id="rule-prompt" placeholder="Added on top of the global prompt for this rule only"></textarea>
                </div>
                <div class="field">
                  <label>Workspace folder override</label>
                  <input id="rule-workspace" placeholder="blank = auto per chat">
                  <span class="field-help">Rare. Normally each chat gets its own folder automatically.</span>
                </div>
                <div class="rule-form-actions">
                  <button class="primary" type="submit" id="rule-submit-btn">Add rule</button>
                  <button class="secondary hidden" type="button" id="rule-cancel-btn">Cancel</button>
                </div>
              </form>
              <table><thead><tr><th>Rule</th><th>Scope</th><th>Triggers</th><th>Sandbox</th><th></th></tr></thead><tbody id="codex-rule-rows"></tbody></table>
            </div>
          </div>

          <div>
            <div class="codex-card">
              <h2>${icons.folder} Chat workspaces</h2>
              <p class="section-help">One folder per WhatsApp chat (not per rule). Created on first run. Contains memory.md, artifacts/, and conversation history.</p>
              <div class="info-box">
                <span class="muted">Base folder on this machine</span>
                <span id="codex-workspace-path" class="id"></span>
              </div>
            </div>

            <div class="codex-card">
              <h2>${icons.memory} Chat memory</h2>
              <p class="section-help">View or edit durable notes Codex keeps for a chat. Stored in that chat's workspace/memory.md.</p>
              <form id="codex-memory-form" class="field">
                <label>Select chat</label>
                <div class="combo" id="memory-chat-combo">
                  <button type="button" class="combo-trigger" id="memory-chat-trigger">Choose a group or contact</button>
                  <div class="combo-menu hidden" id="memory-chat-menu">
                    <input type="text" class="combo-search" id="memory-chat-search" placeholder="Search groups and contacts…" autocomplete="off">
                    <div class="combo-options" id="memory-chat-options"></div>
                  </div>
                  <input type="hidden" id="memory-chat-id" value="">
                  <input type="hidden" id="memory-chat-name" value="">
                </div>
                <label>Memory notes</label>
                <textarea id="memory-text" placeholder="Load memory for a chat, edit, then save"></textarea>
                <div class="bar">
                  <button id="memory-load" class="secondary" type="button">Load memory</button>
                  <button class="primary" type="submit">Save memory</button>
                </div>
              </form>
            </div>

            <div class="codex-card">
              <h2>${icons.activity} Recent activity</h2>
              <p class="section-help">Codex runs triggered by incoming WhatsApp messages.</p>
              <table><thead><tr><th>Run</th><th>Status</th></tr></thead><tbody id="codex-run-rows"></tbody></table>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>
  <div id="toast" class="toast"></div>

  <script>
    const esc = (v) => { const d = document.createElement('div'); d.textContent = String(v ?? ''); return d.innerHTML; };
    const toast = (m) => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1600); };
    const copy = (v) => { navigator.clipboard.writeText(v); toast('Copied ' + v); };
	    let codexRulesCache = [];
	    let editingRuleId = null;
	    let selectedChat = { id: '', label: 'Any matching chat' };
	    let selectedMemoryChat = { id: '', label: 'Choose a group or contact', isGroup: false };
	    let cronJobsCache = [];
	    let editingCronJobId = null;
	    const cronDefaultSteps = [
	      { type: 'http', id: 'fetch', method: 'GET', url: 'https://example.com/api', headers: { authorization: 'Bearer \${env:API_KEY}' }, saveAs: 'fetch' },
	      { type: 'codex', id: 'draft', prompt: 'Use \${steps.fetch.body} and the job memory to draft the WhatsApp response.', sandbox: 'workspace-write', saveAs: 'draft' },
	      { type: 'whatsapp', id: 'send', to: '120363000000000000@g.us', text: '\${steps.draft.text}' },
	    ];
	    const cronDayNames = {
	      0: 'Sunday',
	      1: 'Monday',
	      2: 'Tuesday',
	      3: 'Wednesday',
	      4: 'Thursday',
	      5: 'Friday',
	      6: 'Saturday',
	    };

    document.querySelectorAll('.tabs button').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
	        ['groups','contacts','webhooks','cron','codex'].forEach((t) =>
          document.getElementById('tab-' + t).classList.toggle('hidden', t !== btn.dataset.tab));
      };
    });

    async function loadStatus() {
      try {
        const s = await fetch('/api/status').then((r) => r.json());
        const el = document.getElementById('status');
        el.textContent = s.connected ? ('Connected · ' + s.groupCount + ' groups · ' + s.contactCount + ' contacts') : 'Disconnected';
        el.className = 'status ' + (s.connected ? 'ok' : '');
      } catch {}
    }

    async function loadGroups() {
      const q = document.getElementById('group-search').value;
      const rows = await fetch('/api/groups?q=' + encodeURIComponent(q) + '&limit=200').then((r) => r.json());
      document.getElementById('group-rows').innerHTML = rows.length ? rows.map((g) =>
        '<tr><td>' + esc(g.name) + '</td><td class="id">' + esc(g.id) + '</td><td>' + (g.participantCount ?? '—') +
        '</td><td><button class="copy" data-id="' + esc(g.id) + '">Copy ID</button></td></tr>').join('')
        : '<tr><td colspan="4" class="muted">No groups yet.</td></tr>';
    }

    async function loadContacts() {
      const q = document.getElementById('contact-search').value;
      const rows = await fetch('/api/contacts?q=' + encodeURIComponent(q) + '&limit=200').then((r) => r.json());
      document.getElementById('contact-rows').innerHTML = rows.length ? rows.map((c) =>
        '<tr><td>' + esc(c.name || '—') + '</td><td>' + esc(c.number) + '</td><td class="id">' + esc(c.id) +
        '</td><td><button class="copy" data-id="' + esc(c.id) + '">Copy ID</button></td></tr>').join('')
        : '<tr><td colspan="4" class="muted">No contacts yet.</td></tr>';
    }

	    async function loadWebhooks() {
	      const rows = await fetch('/api/webhooks').then((r) => r.json());
	      document.getElementById('wh-rows').innerHTML = rows.length ? rows.map((w) =>
	        '<tr><td class="id">' + esc(w.url) + '</td><td class="id">' + esc(w.chatId || 'all') + '</td><td class="muted">' +
	        esc((w.createdAt || '').slice(0, 10)) + '</td><td><button class="del" data-id="' + esc(w.id) + '">Delete</button></td></tr>').join('')
	        : '<tr><td colspan="4" class="muted">No webhooks.</td></tr>';
	    }

	    async function loadCron() {
	      const [cfg, status] = await Promise.all([
	        fetch('/api/cron/config').then((r) => r.json()),
	        fetch('/api/cron/status').then((r) => r.json()),
	      ]);
	      document.getElementById('cron-enabled').checked = !!cfg.enabled;
	      document.getElementById('cron-timezone').value = cfg.defaultTimezone || 'America/New_York';
	      document.getElementById('cron-job-timezone').placeholder = cfg.defaultTimezone || 'America/New_York';
	      cronJobsCache = cfg.jobs || [];
	      renderCronJobs(cronJobsCache, status.jobs || []);
	      renderCronRuns(status.recentRuns || []);
	      renderCronMemoryOptions();

	      const badge = document.getElementById('cron-enabled-badge');
	      badge.textContent = cfg.enabled ? 'scheduler on' : 'scheduler off';
	      badge.className = 'badge ' + (cfg.enabled ? 'ok' : '');
	      const codexBadge = document.getElementById('cron-codex-badge');
	      codexBadge.textContent = status.codex?.ready ? 'Codex ready' : 'Install Codex SDK';
	      codexBadge.className = 'badge ' + (status.codex?.ready ? 'ok' : '');
	      document.getElementById('cron-root').textContent = status.rootDir || '';
	    }

	    function renderCronJobs(jobs, summaries) {
	      const summaryById = Object.fromEntries((summaries || []).map((item) => [item.id, item]));
	      document.getElementById('cron-job-list').innerHTML = jobs.length ? jobs.map((job) => {
	        const summary = summaryById[job.id] || {};
	        const meta = [
		          job.enabled ? 'enabled' : 'disabled',
		          job.previewOnly ? 'preview' : 'auto-send',
		          describeCronExpression(job.schedule?.expression || ''),
		          summary.nextRunAt ? 'next ' + summary.nextRunAt.replace('T', ' ').slice(0, 16) : '',
	        ].filter(Boolean).map((item) => '<span class="badge' + (item === 'enabled' ? ' ok' : '') + '">' + esc(item) + '</span>').join('');
	        return '<div class="job-card"><div class="job-card-head"><div><h3>' + esc(job.name || job.id) +
	          '</h3><div class="id">' + esc(job.id) + '</div></div><div class="rule-actions">' +
	          '<button class="edit cron-edit" data-id="' + esc(job.id) + '">Edit</button>' +
	          '<button class="edit cron-run" data-id="' + esc(job.id) + '">Run</button>' +
	          '<button class="del cron-del" data-id="' + esc(job.id) + '">Delete</button>' +
	          '</div></div><div class="job-meta">' + meta + '</div></div>';
	      }).join('') : '<div class="job-card muted">No cron jobs.</div>';
	    }

	    function renderCronRuns(runs) {
	      document.getElementById('cron-run-rows').innerHTML = runs.length ? runs.map((run) =>
	        '<tr><td><b>' + esc(run.jobName || run.jobId || 'Cron job') + '</b><div class="id">' + esc(run.id || '') +
	        '</div><div class="muted">' + esc((run.startedAt || '').replace('T', ' ').slice(0, 19)) +
	        '</div></td><td>' + (run.ok ? '<span class="badge ok">ok</span>' : '<span class="badge">failed</span>') +
	        '<div class="muted">' + esc(run.error || (run.previewOnly ? 'preview only' : run.trigger || '')) + '</div></td></tr>').join('')
	        : '<tr><td colspan="2" class="muted">No cron runs yet.</td></tr>';
	    }

	    function renderCronMemoryOptions() {
	      const select = document.getElementById('cron-memory-job');
	      const current = select.value;
	      select.innerHTML = cronJobsCache.length ? cronJobsCache.map((job) =>
	        '<option value="' + esc(job.id) + '">' + esc(job.name || job.id) + '</option>').join('')
	        : '<option value="">No jobs</option>';
	      if (cronJobsCache.some((job) => job.id === current)) select.value = current;
	    }

	    function resetCronJobForm() {
	      editingCronJobId = null;
	      document.getElementById('cron-job-form').reset();
	      document.getElementById('cron-job-enabled').checked = true;
	      document.getElementById('cron-expression').value = '0 6 * * *';
	      document.getElementById('cron-job-timezone').value = document.getElementById('cron-timezone').value || 'America/New_York';
	      document.getElementById('cron-env').value = JSON.stringify({ API_KEY: 'BIRTHDAY_API_KEY' }, null, 2);
	      document.getElementById('cron-steps').value = JSON.stringify(cronDefaultSteps, null, 2);
	      document.getElementById('cron-submit-btn').textContent = 'Add job';
	      document.getElementById('cron-cancel-btn').classList.add('hidden');
	      document.getElementById('cron-job-id').disabled = false;
	      syncScheduleBuilderFromExpression();
	    }

	    function populateCronJobForm(job) {
	      editingCronJobId = job.id;
	      document.getElementById('cron-job-name').value = job.name || '';
	      document.getElementById('cron-job-id').value = job.id || '';
	      document.getElementById('cron-job-id').disabled = true;
	      document.getElementById('cron-expression').value = job.schedule?.expression || '0 6 * * *';
	      document.getElementById('cron-job-timezone').value = job.schedule?.timezone || document.getElementById('cron-timezone').value || 'America/New_York';
	      document.getElementById('cron-job-enabled').checked = job.enabled !== false;
	      document.getElementById('cron-preview-only').checked = !!job.previewOnly;
	      document.getElementById('cron-allow-overlap').checked = !!job.allowOverlap;
	      document.getElementById('cron-env').value = JSON.stringify(job.env || {}, null, 2);
	      document.getElementById('cron-steps').value = JSON.stringify(job.steps || [], null, 2);
	      document.getElementById('cron-submit-btn').textContent = 'Save job';
	      document.getElementById('cron-cancel-btn').classList.remove('hidden');
	      syncScheduleBuilderFromExpression();
	      document.getElementById('cron-job-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	    }

	    function cronJobFromForm() {
	      return {
	        name: document.getElementById('cron-job-name').value.trim(),
	        id: document.getElementById('cron-job-id').value.trim(),
	        enabled: document.getElementById('cron-job-enabled').checked,
	        schedule: {
	          expression: document.getElementById('cron-expression').value.trim(),
	          timezone: document.getElementById('cron-job-timezone').value.trim() || document.getElementById('cron-timezone').value.trim(),
	        },
	        previewOnly: document.getElementById('cron-preview-only').checked,
	        allowOverlap: document.getElementById('cron-allow-overlap').checked,
	        env: parseJsonField('cron-env', {}),
	        steps: parseJsonField('cron-steps', []),
	      };
	    }

	    function syncScheduleBuilderFromExpression() {
	      const expression = document.getElementById('cron-expression').value.trim();
	      const parsed = parseCronExpressionForBuilder(expression);
	      document.getElementById('cron-schedule-mode').value = parsed.mode;
	      if (parsed.time) document.getElementById('cron-schedule-time').value = parsed.time;
	      if (parsed.monthday) document.getElementById('cron-monthday').value = parsed.monthday;
	      setCronWeekdays(parsed.days || []);
	      renderScheduleBuilderState(parsed.summary);
	    }

	    function applyScheduleBuilderToExpression() {
	      const mode = document.getElementById('cron-schedule-mode').value;
	      if (mode === 'custom') {
	        renderScheduleBuilderState(describeCronExpression(document.getElementById('cron-expression').value.trim()));
	        return;
	      }
	      const time = getScheduleTimeParts();
	      let expression = time.minute + ' ' + time.hour + ' * * *';
	      if (mode === 'weekdays') expression = time.minute + ' ' + time.hour + ' * * 1-5';
	      if (mode === 'weekly') {
	        const days = getCronWeekdays();
	        expression = time.minute + ' ' + time.hour + ' * * ' + (days.length ? days.join(',') : '1');
	      }
	      if (mode === 'monthly') {
	        const day = clampNumber(document.getElementById('cron-monthday').value, 1, 31, 1);
	        document.getElementById('cron-monthday').value = String(day);
	        expression = time.minute + ' ' + time.hour + ' ' + day + ' * *';
	      }
	      document.getElementById('cron-expression').value = expression;
	      syncScheduleBuilderFromExpression();
	    }

	    function renderScheduleBuilderState(summary) {
	      const mode = document.getElementById('cron-schedule-mode').value;
	      document.getElementById('cron-weekday-field').classList.toggle('hidden', mode !== 'weekly');
	      document.getElementById('cron-monthday-field').classList.toggle('hidden', mode !== 'monthly');
	      document.getElementById('cron-schedule-time').disabled = mode === 'custom';
	      document.querySelectorAll('.weekday-chip').forEach((button) => {
	        button.disabled = mode !== 'weekly';
	      });
	      document.getElementById('cron-schedule-summary').textContent = summary || describeCronExpression(document.getElementById('cron-expression').value.trim());
	    }

	    function parseCronExpressionForBuilder(expression) {
	      const parts = String(expression || '').trim().split(/\\s+/).filter(Boolean);
	      if (parts.length !== 5) return { mode: 'custom', summary: 'Custom cron expression.' };
	      const minute = parseCronNumber(parts[0], 0, 59);
	      const hour = parseCronNumber(parts[1], 0, 23);
	      if (minute === null || hour === null || parts[3] !== '*') return { mode: 'custom', summary: 'Custom cron: ' + expression };
	      const time = pad2(hour) + ':' + pad2(minute);
	      const days = parseCronDays(parts[4]);
	      if (parts[2] === '*' && parts[4] === '*') {
	        return { mode: 'daily', time, days: [], summary: 'Every day at ' + formatTime(hour, minute) + '.' };
	      }
	      if (parts[2] === '*' && parts[4] === '1-5' && sameDays(days, [1, 2, 3, 4, 5])) {
	        return { mode: 'weekdays', time, days: [1, 2, 3, 4, 5], summary: 'Weekdays at ' + formatTime(hour, minute) + '.' };
	      }
	      if (parts[2] === '*' && days && days.length > 0) {
	        return { mode: 'weekly', time, days, summary: 'Every ' + formatDays(days) + ' at ' + formatTime(hour, minute) + '.' };
	      }
	      const monthday = parseCronNumber(parts[2], 1, 31);
	      if (monthday !== null && parts[4] === '*') {
	        return { mode: 'monthly', time, monthday, days: [], summary: 'Monthly on day ' + monthday + ' at ' + formatTime(hour, minute) + '.' };
	      }
	      return { mode: 'custom', time, days: [], summary: 'Custom cron: ' + expression };
	    }

	    function describeCronExpression(expression) {
	      return parseCronExpressionForBuilder(expression).summary;
	    }

	    function getScheduleTimeParts() {
	      const raw = document.getElementById('cron-schedule-time').value || '06:00';
	      const [hourRaw, minuteRaw] = raw.split(':');
	      return {
	        hour: clampNumber(hourRaw, 0, 23, 6),
	        minute: clampNumber(minuteRaw, 0, 59, 0),
	      };
	    }

	    function setCronWeekdays(days) {
	      const set = new Set((days || []).map((day) => String(day)));
	      document.querySelectorAll('.weekday-chip').forEach((button) => {
	        button.classList.toggle('active', set.has(button.dataset.day));
	      });
	    }

	    function getCronWeekdays() {
	      return Array.from(document.querySelectorAll('.weekday-chip.active')).map((button) => Number(button.dataset.day));
	    }

	    function parseCronDays(field) {
	      if (!field || field === '*') return null;
	      if (field.includes('/')) return null;
	      const out = new Set();
	      for (const segment of field.split(',')) {
	        if (!segment) return null;
	        const [startRaw, endRaw] = segment.split('-');
	        const start = parseCronDayNumber(startRaw);
	        const end = endRaw === undefined ? start : parseCronDayNumber(endRaw);
	        if (start === null || end === null) return null;
	        if (start <= end) {
	          for (let day = start; day <= end; day += 1) out.add(day === 7 ? 0 : day);
	        } else {
	          for (let day = start; day <= 6; day += 1) out.add(day);
	          for (let day = 0; day <= end; day += 1) out.add(day);
	        }
	      }
	      const order = [1, 2, 3, 4, 5, 6, 0];
	      return order.filter((day) => out.has(day));
	    }

	    function parseCronNumber(value, min, max) {
	      if (!/^\\d+$/.test(String(value || ''))) return null;
	      const number = Number(value);
	      return number >= min && number <= max ? number : null;
	    }

	    function parseCronDayNumber(value) {
	      const number = parseCronNumber(value, 0, 7);
	      return number === 7 ? 0 : number;
	    }

	    function sameDays(a, b) {
	      return Array.isArray(a) && a.length === b.length && a.every((day, index) => day === b[index]);
	    }

	    function formatDays(days) {
	      const labels = (days || []).map((day) => cronDayNames[day]).filter(Boolean);
	      if (labels.length === 1) return labels[0];
	      if (labels.length === 2) return labels.join(' and ');
	      return labels.slice(0, -1).join(', ') + ', and ' + labels[labels.length - 1];
	    }

	    function formatTime(hour, minute) {
	      const suffix = hour >= 12 ? 'PM' : 'AM';
	      const displayHour = hour % 12 || 12;
	      return displayHour + ':' + pad2(minute) + ' ' + suffix;
	    }

	    function pad2(value) {
	      return String(value).padStart(2, '0');
	    }

	    function clampNumber(value, min, max, fallback) {
	      const number = Number(value);
	      if (!Number.isFinite(number)) return fallback;
	      return Math.max(min, Math.min(max, Math.trunc(number)));
	    }

	    async function loadCodex() {
      const [cfg, status] = await Promise.all([
        fetch('/api/codex/config').then((r) => r.json()),
        fetch('/api/codex/status').then((r) => r.json()),
      ]);
      document.getElementById('codex-enabled').checked = !!cfg.enabled;
      document.getElementById('codex-default-sandbox').value = cfg.defaultSandbox || 'full-access';
      document.getElementById('codex-model').value = cfg.model || '';
      document.getElementById('codex-auto-reply').checked = cfg.autoReply !== false;
      document.getElementById('codex-network').checked = cfg.networkAccessEnabled !== false;
      document.getElementById('codex-workspace-root').value = cfg.workspaceRoot || '';
      document.getElementById('codex-default-prompt').value = cfg.defaultPrompt || '';

      const ready = document.getElementById('codex-ready');
      ready.textContent = status.ready ? 'Codex ready' : 'Install Codex SDK';
      ready.className = 'badge ' + (status.ready ? 'ok' : '');
      document.getElementById('codex-workspace-path').textContent = status.workspaceRoot || '';
      updateCodexPanelVisibility(!!cfg.enabled);
      const installNote = document.getElementById('codex-install-note');
      if (!status.ready) {
        installNote.textContent = 'Codex not installed — run: ' + (status.installCommand || 'npm install @openai/codex-sdk');
        installNote.classList.remove('hidden');
      } else {
        installNote.classList.add('hidden');
      }
      codexRulesCache = cfg.rules || [];
      renderCodexRules(codexRulesCache);
      renderCodexRuns(status.recentRuns || []);
    }

    function updateCodexPanelVisibility(enabled) {
      document.getElementById('codex-active-panel').classList.toggle('hidden', !enabled);
      document.getElementById('codex-disabled-note').classList.toggle('hidden', enabled);
      const badge = document.getElementById('codex-routing-badge');
      badge.textContent = enabled ? 'routing on' : 'routing off';
      badge.className = 'badge ' + (enabled ? 'ok' : '');
    }

    function renderCodexRules(rules) {
      document.getElementById('codex-rule-rows').innerHTML = rules.length ? rules.map((rule) => {
        const scope = [rule.chatType || 'all', rule.chatId || 'any chat'].join(' · ');
        const triggers = [
          rule.allowFromMe ? 'my msgs' : '',
          rule.requireMention ? '@ me' : '',
          (rule.allowedSenderIds || []).length ? 'senders: ' + rule.allowedSenderIds.length : '',
          (rule.keywords || []).length ? 'keywords: ' + rule.keywords.join(', ') : '',
        ].filter(Boolean).join(' · ') || 'all messages';
        return '<tr><td><b>' + esc(rule.name) + '</b><div class="muted">' + (rule.enabled ? 'enabled' : 'disabled') +
          '</div></td><td class="id">' + esc(scope) + '</td><td>' + esc(triggers) + '</td><td>' + esc(rule.sandbox || 'default') +
          '</td><td class="rule-actions"><button class="edit codex-edit" data-id="' + esc(rule.id) + '">Edit</button>' +
          '<button class="del codex-del" data-id="' + esc(rule.id) + '">Delete</button></td></tr>';
      }).join('') : '<tr><td colspan="5" class="muted">No Codex rules.</td></tr>';
    }

    function setSelectedChat(id, label) {
      selectedChat = { id: id || '', label: label || 'Any matching chat' };
      document.getElementById('rule-chat-id').value = selectedChat.id;
      document.getElementById('rule-chat-trigger').textContent = selectedChat.label;
    }

    function setSelectedMemoryChat(id, label, isGroup) {
      selectedMemoryChat = { id: id || '', label: label || 'Choose a group or contact', isGroup: !!isGroup };
      document.getElementById('memory-chat-id').value = selectedMemoryChat.id;
      document.getElementById('memory-chat-name').value = selectedMemoryChat.label;
      document.getElementById('memory-chat-trigger').textContent = selectedMemoryChat.label;
    }

    function closeChatMenu() {
      document.getElementById('rule-chat-menu').classList.add('hidden');
      document.getElementById('rule-chat-trigger').classList.remove('open');
    }

    function openChatMenu() {
      document.getElementById('rule-chat-menu').classList.remove('hidden');
      document.getElementById('rule-chat-trigger').classList.add('open');
      const search = document.getElementById('rule-chat-search');
      search.value = '';
      search.focus();
      loadChatOptions('');
    }

    async function fetchChatOptions(q) {
      const chatType = document.getElementById('rule-chat-type').value;
      const limit = 200;
      const query = encodeURIComponent(q || '');
      if (chatType === 'group') {
        return (await fetch('/api/groups?q=' + query + '&limit=' + limit).then((r) => r.json())).map((g) => ({
          id: g.id, label: g.name || g.id, sub: g.id,
        }));
      }
      if (chatType === 'dm') {
        return (await fetch('/api/contacts?q=' + query + '&limit=' + limit).then((r) => r.json())).map((c) => ({
          id: c.id, label: c.name || c.number || c.id, sub: c.number || c.id,
        }));
      }
      const [groups, contacts] = await Promise.all([
        fetch('/api/groups?q=' + query + '&limit=' + limit).then((r) => r.json()),
        fetch('/api/contacts?q=' + query + '&limit=' + limit).then((r) => r.json()),
      ]);
      return [
        ...groups.map((g) => ({ id: g.id, label: g.name || g.id, sub: g.id, kind: 'group' })),
        ...contacts.map((c) => ({ id: c.id, label: c.name || c.number || c.id, sub: c.number || c.id, kind: 'dm' })),
      ];
    }

    async function loadChatOptions(q) {
      const options = await fetchChatOptions(q);
      const items = [{ id: '', label: 'Any matching chat', sub: 'no chat limit' }, ...options];
      document.getElementById('rule-chat-options').innerHTML = items.map((item) =>
        '<button type="button" class="combo-option' + (item.id === selectedChat.id ? ' active' : '') + '" data-id="' + esc(item.id) +
        '" data-label="' + esc(item.label) + '">' + esc(item.label) +
        (item.sub ? '<span class="id">' + esc(item.sub) + '</span>' : '') + '</button>').join('');
    }

    async function fetchAllChatOptions(q) {
      const limit = 200;
      const query = encodeURIComponent(q || '');
      const [groups, contacts] = await Promise.all([
        fetch('/api/groups?q=' + query + '&limit=' + limit).then((r) => r.json()),
        fetch('/api/contacts?q=' + query + '&limit=' + limit).then((r) => r.json()),
      ]);
      return [
        ...groups.map((g) => ({ id: g.id, label: g.name || g.id, sub: g.id, isGroup: true })),
        ...contacts.map((c) => ({ id: c.id, label: c.name || c.number || c.id, sub: c.number || c.id, isGroup: false })),
      ];
    }

    async function loadMemoryChatOptions(q) {
      const options = await fetchAllChatOptions(q);
      document.getElementById('memory-chat-options').innerHTML = options.length ? options.map((item) =>
        '<button type="button" class="combo-option' + (item.id === selectedMemoryChat.id ? ' active' : '') + '" data-id="' + esc(item.id) +
        '" data-label="' + esc(item.label) + '" data-group="' + (item.isGroup ? '1' : '0') + '">' + esc(item.label) +
        (item.sub ? '<span class="id">' + esc(item.sub) + '</span>' : '') + '</button>').join('')
        : '<div class="combo-option muted" style="cursor:default;">No chats found</div>';
    }

    function closeMemoryChatMenu() {
      document.getElementById('memory-chat-menu').classList.add('hidden');
      document.getElementById('memory-chat-trigger').classList.remove('open');
    }

    function openMemoryChatMenu() {
      document.getElementById('memory-chat-menu').classList.remove('hidden');
      document.getElementById('memory-chat-trigger').classList.add('open');
      const search = document.getElementById('memory-chat-search');
      search.value = '';
      search.focus();
      loadMemoryChatOptions('');
    }

    async function resolveChatLabel(chatId) {
      if (!chatId) return 'Any matching chat';
      const options = await fetchAllChatOptions(chatId);
      const match = options.find((item) => item.id === chatId);
      return match ? match.label : chatId;
    }

    function setRuleEditMode(ruleId) {
      editingRuleId = ruleId || null;
      document.getElementById('rule-submit-btn').textContent = editingRuleId ? 'Save Rule' : 'Add Rule';
      document.getElementById('rule-cancel-btn').classList.toggle('hidden', !editingRuleId);
    }

    async function populateRuleForm(rule) {
      document.getElementById('rule-name').value = rule.name || '';
      document.getElementById('rule-chat-type').value = rule.chatType || 'group';
      document.getElementById('rule-sandbox').value = rule.sandbox || 'full-access';
      document.getElementById('rule-require-mention').checked = !!rule.requireMention;
      document.getElementById('rule-allow-from-me').checked = !!rule.allowFromMe;
      document.getElementById('rule-senders').value = (rule.allowedSenderIds || []).join('\\n');
      document.getElementById('rule-keywords').value = (rule.keywords || []).join('\\n');
      document.getElementById('rule-prompt').value = rule.prompt || '';
      document.getElementById('rule-workspace').value = rule.workspaceSubdir || '';
      document.getElementById('rule-auto-reply').value =
        rule.autoReply === true ? 'true' : rule.autoReply === false ? 'false' : '';
      const label = await resolveChatLabel(rule.chatId || '');
      setSelectedChat(rule.chatId || '', label);
      setRuleEditMode(rule.id);
      document.getElementById('codex-rule-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function resetRuleForm() {
      document.getElementById('codex-rule-form').reset();
      document.getElementById('rule-sandbox').value = 'full-access';
      document.getElementById('rule-auto-reply').value = '';
      setSelectedChat('', 'Any matching chat');
      closeChatMenu();
      setRuleEditMode(null);
    }

    function renderCodexRuns(runs) {
      document.getElementById('codex-run-rows').innerHTML = runs.length ? runs.map((run) =>
        '<tr><td><b>' + esc(run.ruleName || 'Codex') + '</b><div class="id">' + esc(run.chatName || run.chatId || '') +
        '</div><div class="muted">' + esc((run.startedAt || '').replace('T', ' ').slice(0, 19)) +
        '</div></td><td>' + (run.ok ? '<span class="badge ok">ok</span>' : '<span class="badge">failed</span>') +
        '<div class="muted">' + esc(run.error || (run.response || '').slice(0, 90)) + '</div></td></tr>').join('')
        : '<tr><td colspan="2" class="muted">No Codex runs yet.</td></tr>';
    }

    document.body.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('.copy');
      if (copyBtn) { copy(copyBtn.dataset.id); return; }
	      const editBtn = e.target.closest('.codex-edit');
	      if (editBtn) {
	        const rule = codexRulesCache.find((item) => item.id === editBtn.dataset.id);
	        if (rule) populateRuleForm(rule);
	        return;
	      }
	      const cronEditBtn = e.target.closest('.cron-edit');
	      if (cronEditBtn) {
	        const job = cronJobsCache.find((item) => item.id === cronEditBtn.dataset.id);
	        if (job) {
	          populateCronJobForm(job);
	          document.getElementById('cron-memory-job').value = job.id;
	        }
	        return;
	      }
	      const cronRunBtn = e.target.closest('.cron-run');
	      if (cronRunBtn) {
	        toast('Cron job started');
	        const res = await fetch('/api/cron/jobs/' + encodeURIComponent(cronRunBtn.dataset.id) + '/run', { method: 'POST' });
	        const body = await res.json().catch(() => ({}));
	        toast(res.ok && body.ok ? 'Cron job finished' : (body.error || 'Cron job failed'));
	        loadCron();
	        return;
	      }
      const chatOption = e.target.closest('.combo-option');
      if (chatOption && chatOption.closest('#rule-chat-options')) {
        setSelectedChat(chatOption.dataset.id, chatOption.dataset.label);
        closeChatMenu();
        return;
      }
      if (chatOption && chatOption.closest('#memory-chat-options')) {
        setSelectedMemoryChat(chatOption.dataset.id, chatOption.dataset.label, chatOption.dataset.group === '1');
        closeMemoryChatMenu();
        return;
      }
      if (!e.target.closest('#rule-chat-combo')) closeChatMenu();
      if (!e.target.closest('#memory-chat-combo')) closeMemoryChatMenu();
	      const delBtn = e.target.closest('.del');
	      if (delBtn) {
	        if (delBtn.classList.contains('codex-del')) {
	          await fetch('/api/codex/rules/' + encodeURIComponent(delBtn.dataset.id), { method: 'DELETE' });
	          if (editingRuleId === delBtn.dataset.id) resetRuleForm();
	          loadCodex();
	        } else if (delBtn.classList.contains('cron-del')) {
	          await fetch('/api/cron/jobs/' + encodeURIComponent(delBtn.dataset.id), { method: 'DELETE' });
	          if (editingCronJobId === delBtn.dataset.id) resetCronJobForm();
	          toast('Cron job deleted');
	          loadCron();
	        } else {
	          await fetch('/api/webhooks/' + encodeURIComponent(delBtn.dataset.id), { method: 'DELETE' });
	          loadWebhooks();
        }
      }
    });

    document.getElementById('group-search').addEventListener('input', debounce(loadGroups, 200));
    document.getElementById('contact-search').addEventListener('input', debounce(loadContacts, 200));

	    document.getElementById('wh-form').addEventListener('submit', async (e) => {
	      e.preventDefault();
	      const body = {
	        url: document.getElementById('wh-url').value.trim(),
        chatId: document.getElementById('wh-chat').value.trim() || undefined,
        secret: document.getElementById('wh-secret').value.trim() || undefined,
      };
      const res = await fetch('/api/webhooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) { e.target.reset(); toast('Webhook added'); loadWebhooks(); }
	      else { const b = await res.json().catch(() => ({})); toast(b.error || 'Failed'); }
	    });

	    document.getElementById('cron-refresh').addEventListener('click', loadCron);
	    document.getElementById('cron-cancel-btn').addEventListener('click', resetCronJobForm);
	    document.getElementById('cron-expression').addEventListener('input', syncScheduleBuilderFromExpression);
	    document.getElementById('cron-schedule-mode').addEventListener('change', () => {
	      const mode = document.getElementById('cron-schedule-mode').value;
	      if (mode === 'weekly' && (getCronWeekdays().length === 0 || sameDays(getCronWeekdays(), [1, 2, 3, 4, 5]))) setCronWeekdays([1]);
	      if (mode === 'weekdays') setCronWeekdays([1, 2, 3, 4, 5]);
	      applyScheduleBuilderToExpression();
	    });
	    document.getElementById('cron-schedule-time').addEventListener('input', applyScheduleBuilderToExpression);
	    document.getElementById('cron-monthday').addEventListener('input', applyScheduleBuilderToExpression);
	    document.querySelectorAll('.weekday-chip').forEach((button) => {
	      button.addEventListener('click', () => {
	        document.getElementById('cron-schedule-mode').value = 'weekly';
	        button.classList.toggle('active');
	        if (getCronWeekdays().length === 0) button.classList.add('active');
	        applyScheduleBuilderToExpression();
	      });
	    });

	    document.getElementById('cron-config-form').addEventListener('submit', async (e) => {
	      e.preventDefault();
	      const body = {
	        enabled: document.getElementById('cron-enabled').checked,
	        defaultTimezone: document.getElementById('cron-timezone').value.trim() || 'America/New_York',
	      };
	      const res = await fetch('/api/cron/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	      if (res.ok) { toast('Scheduler saved'); loadCron(); }
	      else { const b = await res.json().catch(() => ({})); toast(b.error || 'Failed'); }
	    });

	    document.getElementById('cron-enabled').addEventListener('change', async (e) => {
	      const enabled = e.target.checked;
	      const res = await fetch('/api/cron/config', {
	        method: 'PUT',
	        headers: { 'content-type': 'application/json' },
	        body: JSON.stringify({ enabled, defaultTimezone: document.getElementById('cron-timezone').value.trim() || 'America/New_York' }),
	      });
	      if (res.ok) { toast(enabled ? 'Scheduler enabled' : 'Scheduler disabled'); loadCron(); }
	      else {
	        const b = await res.json().catch(() => ({}));
	        toast(b.error || 'Failed');
	        e.target.checked = !enabled;
	      }
	    });

	    document.getElementById('cron-job-form').addEventListener('submit', async (e) => {
	      e.preventDefault();
	      let body;
	      try { body = cronJobFromForm(); }
	      catch (err) { toast(err.message); return; }
	      const url = editingCronJobId ? '/api/cron/jobs/' + encodeURIComponent(editingCronJobId) : '/api/cron/jobs';
	      const method = editingCronJobId ? 'PUT' : 'POST';
	      const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	      const out = await res.json().catch(() => ({}));
	      if (res.ok) {
	        toast(editingCronJobId ? 'Cron job updated' : 'Cron job added');
	        resetCronJobForm();
	        loadCron();
	      } else toast(out.error || 'Failed');
	    });

	    document.getElementById('cron-memory-load').addEventListener('click', async () => {
	      const jobId = document.getElementById('cron-memory-job').value;
	      if (!jobId) return toast('Choose a job');
	      const res = await fetch('/api/cron/jobs/' + encodeURIComponent(jobId) + '/memory');
	      const body = await res.json().catch(() => ({}));
	      if (res.ok) { document.getElementById('cron-memory-text').value = body.text || ''; toast('Memory loaded'); }
	      else toast(body.error || 'Failed');
	    });

	    document.getElementById('cron-memory-form').addEventListener('submit', async (e) => {
	      e.preventDefault();
	      const jobId = document.getElementById('cron-memory-job').value;
	      if (!jobId) return toast('Choose a job');
	      const res = await fetch('/api/cron/jobs/' + encodeURIComponent(jobId) + '/memory', {
	        method: 'PUT',
	        headers: { 'content-type': 'application/json' },
	        body: JSON.stringify({ text: document.getElementById('cron-memory-text').value }),
	      });
	      const body = await res.json().catch(() => ({}));
	      if (res.ok) { document.getElementById('cron-memory-text').value = body.text || ''; toast('Memory saved'); }
	      else toast(body.error || 'Failed');
	    });

	    document.getElementById('cron-chat-form').addEventListener('submit', async (e) => {
	      e.preventDefault();
	      const message = document.getElementById('cron-chat-message').value.trim();
	      if (!message) return toast('Message Codex first');
	      const log = document.getElementById('cron-chat-log');
	      log.classList.remove('muted');
	      log.textContent = 'Codex is working...';
	      const res = await fetch('/api/cron/chat', {
	        method: 'POST',
	        headers: { 'content-type': 'application/json' },
	        body: JSON.stringify({ message }),
	      });
	      const body = await res.json().catch(() => ({}));
	      log.textContent = body.message || body.error || 'No response';
	      toast(res.ok && body.ok !== false ? 'Codex replied' : 'Codex could not run');
	      loadCron();
	    });

	    document.getElementById('codex-refresh').addEventListener('click', loadCodex);

    document.getElementById('codex-enabled').addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      updateCodexPanelVisibility(enabled);
      const res = await fetch('/api/codex/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) toast(enabled ? 'Codex routing enabled' : 'Codex routing disabled');
      else {
        const b = await res.json().catch(() => ({}));
        toast(b.error || 'Failed');
        e.target.checked = !enabled;
        updateCodexPanelVisibility(!enabled);
      }
    });

    document.getElementById('codex-config-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        defaultSandbox: document.getElementById('codex-default-sandbox').value,
        model: document.getElementById('codex-model').value.trim(),
        autoReply: document.getElementById('codex-auto-reply').checked,
        networkAccessEnabled: document.getElementById('codex-network').checked,
        workspaceRoot: document.getElementById('codex-workspace-root').value.trim(),
        defaultPrompt: document.getElementById('codex-default-prompt').value,
      };
      const res = await fetch('/api/codex/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) { toast('Global defaults saved'); loadCodex(); }
      else { const b = await res.json().catch(() => ({})); toast(b.error || 'Failed'); }
    });

    document.getElementById('rule-chat-trigger').addEventListener('click', () => {
      const menu = document.getElementById('rule-chat-menu');
      if (menu.classList.contains('hidden')) openChatMenu();
      else closeChatMenu();
    });
    document.getElementById('rule-chat-search').addEventListener('input', debounce(() => loadChatOptions(document.getElementById('rule-chat-search').value), 200));
    document.getElementById('rule-chat-type').addEventListener('change', () => {
      setSelectedChat('', 'Any matching chat');
      if (!document.getElementById('rule-chat-menu').classList.contains('hidden')) loadChatOptions(document.getElementById('rule-chat-search').value);
    });
    document.getElementById('memory-chat-trigger').addEventListener('click', () => {
      const menu = document.getElementById('memory-chat-menu');
      if (menu.classList.contains('hidden')) openMemoryChatMenu();
      else closeMemoryChatMenu();
    });
    document.getElementById('memory-chat-search').addEventListener('input', debounce(() => loadMemoryChatOptions(document.getElementById('memory-chat-search').value), 200));
    document.getElementById('rule-allow-from-me').addEventListener('change', (e) => {
      if (!e.target.checked) return;
      const keywordsEl = document.getElementById('rule-keywords');
      if (!keywordsEl.value.trim()) keywordsEl.value = 'codex';
    });
    document.getElementById('rule-cancel-btn').addEventListener('click', resetRuleForm);

    document.getElementById('codex-rule-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const autoReplyRaw = document.getElementById('rule-auto-reply').value;
      const allowFromMe = document.getElementById('rule-allow-from-me').checked;
      const keywordsEl = document.getElementById('rule-keywords');
      if (allowFromMe && !keywordsEl.value.trim()) keywordsEl.value = 'codex';
      const body = {
        name: document.getElementById('rule-name').value.trim(),
        chatType: document.getElementById('rule-chat-type').value,
        sandbox: document.getElementById('rule-sandbox').value,
        chatId: document.getElementById('rule-chat-id').value.trim(),
        requireMention: document.getElementById('rule-require-mention').checked,
        allowFromMe,
        allowedSenderIds: lines('rule-senders'),
        keywords: lines('rule-keywords'),
        prompt: document.getElementById('rule-prompt').value.trim(),
        workspaceSubdir: document.getElementById('rule-workspace').value.trim(),
      };
      if (autoReplyRaw) body.autoReply = autoReplyRaw === 'true';
      const url = editingRuleId ? '/api/codex/rules/' + encodeURIComponent(editingRuleId) : '/api/codex/rules';
      const method = editingRuleId ? 'PUT' : 'POST';
      const wasEditing = !!editingRuleId;
      const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        resetRuleForm();
        toast(wasEditing ? 'Codex rule updated' : 'Codex rule added');
        loadCodex();
      } else { const b = await res.json().catch(() => ({})); toast(b.error || 'Failed'); }
    });

    document.getElementById('memory-load').addEventListener('click', async () => {
      const chatId = document.getElementById('memory-chat-id').value.trim();
      if (!chatId) return toast('Select a chat first');
      const params = new URLSearchParams({
        chatId,
        chatName: document.getElementById('memory-chat-name').value.trim(),
        isGroup: selectedMemoryChat.isGroup ? 'true' : 'false',
      });
      const res = await fetch('/api/codex/memory?' + params.toString());
      const body = await res.json().catch(() => ({}));
      if (res.ok) { document.getElementById('memory-text').value = body.text || ''; toast('Memory loaded'); }
      else toast(body.error || 'Failed');
    });

    document.getElementById('codex-memory-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        chatId: document.getElementById('memory-chat-id').value.trim(),
        chatName: document.getElementById('memory-chat-name').value.trim(),
        isGroup: selectedMemoryChat.isGroup,
        text: document.getElementById('memory-text').value,
      };
      if (!body.chatId) return toast('Select a chat first');
      const res = await fetch('/api/codex/memory', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (res.ok) { toast('Memory saved'); document.getElementById('memory-text').value = out.text || body.text; }
      else toast(out.error || 'Failed');
    });

	    function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
	    function lines(id) { return document.getElementById(id).value.split(/\\n|,/).map((v) => v.trim()).filter(Boolean); }
	    function parseJsonField(id, fallback) {
	      const raw = document.getElementById(id).value.trim();
	      if (!raw) return fallback;
	      try { return JSON.parse(raw); }
	      catch { throw new Error('Invalid JSON in ' + id); }
	    }

	    resetCronJobForm();
	    loadStatus(); loadGroups(); loadContacts(); loadWebhooks(); loadCron(); loadCodex();
	    setInterval(loadStatus, 5000);
  </script>
</body>
</html>`
}
