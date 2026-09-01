# Mod compatibility summary

本文件是给 Mod 与后端联调的摘要；`compatibility.md` 保留了完整证据和
字段说明。

## Current C# request facts

- `AiProviderClient` 将基础地址规范化为 `.../chat/completions`，使用
  `Authorization: Bearer ...` 和 JSON。
- 普通 `ConversationEngine` 请求包含 `model`、`messages[{role,content}]`、
  `thinking.type`、`reasoning_effort`、`max_tokens`、`stream`。OpenAI 配置
  将 `max_tokens` 改为 `max_completion_tokens` 并省略 DeepSeek 字段。
- 普通对话 UI 会请求 `stream:true`，按 `data:` SSE 行读取，遇到
  `data: [DONE]` 停止，并拼接 `choices[0].delta.content`；DeepSeek 的
  `delta.reasoning_content` 也会被读取。
- `ConversationToolProviderClient` 工具请求固定 `stream:false`，附带
  `temperature:0.75`、`top_p:0.9`、`tools` 和 `tool_choice`，输出 token
  在 128..2048 之间限制。

## Required tool fidelity

服务端必须原样保留下列字段和关联：

```json
{
  "role":"assistant",
  "content":"",
  "tool_calls":[{
    "id":"call_123",
    "type":"function",
    "function":{"name":"give_gift","arguments":"{\"candidate_key\":\"x\"}"}
  }]
}
```

随后工具结果必须是：

```json
{"role":"tool","tool_call_id":"call_123","content":"{\"ok\":true}"}
```

`function.arguments` 在 Mod 侧按 JSON **字符串**解析为对象；网关不能把
它永久变成数组/对象，也不能生成新的 `tool_call_id`。允许的当前动作是
`give_gift`、`move_to`、`invite_mine_guard`、`invite_fishing_companion`，
最终阶段强制调用 `submit_final_response`。

## Public hosted profile

官方托管配置应使用 `https://<domain>/v1`、设备 Key
`vv_live_...` 和模型别名 `vv-dialogue`/`vv-fast`。保留玩家自填 API 的
自定义提供商模式。旧配置中的 `deepseek-v4-flash` 只在迁移窗口临时映射，
上线前应关闭，避免绕过服务器路由和计费策略。

## Response and error requirements

非流式响应必须是 OpenAI `chat.completion`，包含 `choices[0].message`、
`finish_reason` 和 `usage`；工具响应中的 `tool_calls` 结构不可丢失。流式
响应使用 `text/event-stream`、`choices[0].delta` 和 `[DONE]`。错误使用
`{error:{message,type,code,param}}`，且不得泄露 LiteLLM/供应商密钥或完整
Prompt。每次请求都要支持 `Idempotency-Key`，重试不能重复扣费。
