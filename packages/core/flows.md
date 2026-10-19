# IMURUN Flow Documentation

This document describes the key flows in the IMURUN system based on code inspection.

---

## 1. Agent System Flow

### 1.1 Agent Loading (`loadAgents`)

```
loadAgents(options)
    │
    ├── BUILTIN_AGENTS (build, plan, general, explore)
    │       │
    │       └── Added to Map by ID
    │
    ├── Global agents (~/.imurun/agents/*.md|json)
    │       │
    │       └── Override by ID
    │
    └── Project agents (<workingDir>/.imurun/agents/*.md|json)
            │
            └── Override by ID (wins)
```
#### isToolAllowed(agent, toolName)

```
if agent.disabledTools.includes(toolName) → false
if agent.tools.length === 0 → true (all allowed)
if agent.tools includes "*" → true
if agent.tools includes(toolName) → true
else → false
```
---

### 1.4 Tool Restriction (`restrictToolRegistry`)

```
restrictToolRegistry(registry, agent)
    │
    ├── new ToolRegistry()
    │
    ├── for each tool in registry.list():
    │       │
    │       └── if isToolAllowed(agent, tool.name) → register
    │
    └── return filtered ToolRegistry
```
---

## 2. Subagent (Task Tool) Flow

### 2.1 Task Tool Creation (`createTaskTool`)

```
createTaskTool(runner: SubagentRunner)
    │
    ├── runner.listAgents() → available agent IDs
    │
    ├── Returns ImurunTool with:
    │       ├── name: "task"
    │       ├── description: delegation instructions
    │       ├── parameters: action (one|batch), description, aim, files, approach,
    │       │                 rules, tools, expect, prompt, agent, tasks[]
    │       └── execute(args, ctx) → handles delegation
    │
    └── SubagentRunner interface:
            ├── listAgents(): AgentDefinition[]
            └── run(SubagentRequest): Promise<SubagentResult>
```
### 2.2 Task Tool Execution (`execute`)

```
execute(args, ctx)
    │
    ├── agentId = args.agent ?? ctx.agentId
    │
    ├── shared = { workingDir, sessionId, signal } from ctx
    │
    ├── batch = asBriefs(args.tasks)
    │
    ├── if batch.length > 1:
    │       ├── validate each brief
    │       ├── Promise.all(runOne for each brief)
    │       ├── merge results with headers
    │       └── return ok(merged)
    │
    └── else (single):
            ├── build brief from args or prompt
            ├── validate brief (unless raw prompt given)
            ├── runOne({ prompt, description, agentId })
            └── return ok(formatted result)
```
│
    ├── else (single task):
    │       ├── brief = batch[0] ?? { aim, files, approach, rules, tools, expect }
    │       ├── prompt = args.prompt ?? renderBrief(brief)
    │       ├── validate brief if no raw prompt
    │       │
    │       └── runOne({ prompt, description, agentId })
    │
    └── return ok(`[subagent ${agentId}]\n${result.text}`)
```

---

### 2.3 Subagent Runner (`runSubagent` in TUI)

```
runSubagent(request: SubagentRequest)
    │
    ├── def = resolve agent:
    │       ├── request.agentId → getAgent(agents, agentId)
    │       ├── fallback: caller is subagent mode → caller agent
    │       └── fallback: first taskAgents()[0] (explore)
    │
    ├── push notice: "▹ {agentId} {description}"
    │
    ├── activeSubagents++
    │
    ├── child = sessions.create({ workingDir, model, parentSessionId })
    │
    ├── tools = new ToolRegistry()
    │       │
    │       └── for tool in restrictToolRegistry(subagentTools, def):
    │               if tool.name !== "task" → register
    │               // subagents cannot spawn subagents
    │
    ├── role = def.prompt || undefined
    │
    ├── agent = new Agent({ sessions, providers, tools, permissions, ... })
    │
    ├── forward(event):
    │       ├── tool-start → update subagentLine label
    │       ├── text → request.onEvent({ type: "text", delta })
    │       ├── text-reset → request.onEvent({ type: "reset", text })
    │       ├── tool-start → request.onEvent({ type: "tool", name, title })
    │       └── step-start → request.onEvent({ type: "step", step })
    │
    ├── try:
    │       ├── result = await agent.run({ sessionId: child.id, input: prompt, ... })
    │       ├── push notice: "{agentId} finished · {first line}"
    │       └── return { text: result.text, agentId, sessionId: child.id }
    │
    └── finally:
            activeSubagents--
            if 0 → subagentLine = undefined
            scheduleRender()
```
---

### 2.3 Subagent Runner (`runSubagent` in `app.ts`)

```
runSubagent(request: SubagentRequest): Promise<SubagentResult>
    │
    ├── def = resolve agent:
    │       ├── request.agentId ? getAgent(agents, agentId)
    │       ├── else if (request.agentId === undefined && this.agent.mode === "subagent") → this.agent
    │       └── else → first taskAgents()[0]
    │
    ├── push notice: "▹ agentId [description]"
    │
    ├── activeSubagents++
    │
    ├── child = sessions.create({ workingDir, model, parentSessionId })
    │
    ├── tools = new ToolRegistry()
    │       ├── for tool in restrictToolRegistry(this.subagentTools, def):
    │       │       └── if tool.name !== "task" → tools.register(tool)  // no nested subagents
    │
    ├── role = def.prompt.trim() || undefined
    │
    ├── agent = new Agent({ sessions, providers, tools: this.subagentTools,
    … [2219 more characters not replayed]
├── activeSubagents += 1
    │
    ├── child session = sessions.create({ workingDir, model, parentSessionId })
    │
    ├── tools = restrictToolRegistry(subagentTools, def)
    │       └── filter out "task" tool
    │
    ├── role = def.prompt.trim() || undefined
    │
    ├── agent = new Agent({ sessions, providers, tools, permissions, config, memory })
│
    ├── forward events to caller:
    │       ├── tool-start → update subagentLine, scheduleRender
    │       ├── text → onEvent({ type: "text", delta })
    │       ├── text-reset → onEvent({ type: "reset", text })
    │       ├── step-start → onEvent({ type: "step", step })
    │
    ├── agent.run({ sessionId: child.id, input: prompt, model, workingDir,
    … [453 more characters not replayed]
├── agent.run({ sessionId: child.id, input: prompt, model, workingDir,
    │       agentId: def.id, tools, role, signal, contextWindow, onEvent: forward })
    │
    ├── on finish: push notice with first line of result
    │
    ├── finally: activeSubagents--, clear subagentLine if 0
    │
    └── return { text: result.text, agentId: def.id, sessionId: child.id }
```
---

## 3. Agent Run Flow

### 3.1 Agent Initialization (in `app.ts` constructor)

```
new App()
    │
    ├── sessions = new SessionStore(database)
    ├── providers = new ProviderRegistry(config)
    ├── runtime = new RuntimeManager(config)
    ├── permissions = PermissionManager.withSavedRules(...)
    ├── commands = createCommandRegistry()
    ├── session = sessions.create({ workingDir, model … [3946 more characters not replayed]
├── subagentTools = ToolRegistry.default()
    ├── baseTools = ToolRegistry.default()
    │
    ├── runner: SubagentRunner = { listAgents: () => taskAgents(), run: runSubagent }
    ├── baseTools.register(createTaskTool(runner))
    │
    └── screen, signal handlers, etc.
```
### 3.2 Agent Run (`agent.run`)

```
agent.run({ sessionId, input, model, workingDir, agentId, tools, role, signal, contextWindow, onEvent })
    │
    ├── Create new conversation turn with user input
    │
    ├── Loop until done or signal aborted:
    │       │
    │       ├── Call model with tools, system prompt (role), context
    │       │
    │       ├── Parse model response for tool calls
    │       │
    │       ├── For each tool call:
    │       │       ├── onEvent({ type: "tool-start", name, title })
    │       │       ├── Check permissions
    │       │       ├── Execute tool
    │       │       ├── onEvent({ type: "tool-end", name, result })
    │       │       └── Add tool result to conversation
    │       │
    │       ├── If text response: onEvent({ type: "text", delta })
    │       │
    │       └── Check stop conditions (max turns, context window, etc.)
    │
    └── return { text: accumulatedResponse }
```
│
    ├── For each tool call:
    │       │
    │       ├── Check permissions
    │       ├── onEvent({ type: "tool-start", name, title })
    │       ├── Execute tool
    │       ├── onEvent({ type: "tool-end", name, result })
    │       ├── Add tool result to conversation
    │
    ├── Model returns final text
    │
    ├── onEvent({ type: "text-reset", text: finalText })
    │
    └── return { text: finalText, toolsCalled: [...] }
```
---

## 4. Permission Flow

```
User triggers tool → handlePermission(perm, name)
    │
    ├── Check config.permissions.mode:
    │       ├── "allow" → grant
    │       ├── "deny" → deny
    │       └── "ask" → prompt user (Y/n/always)
    │
    ├── Check saved rules in database for tool name
    │
    ├── If no rule & mode="ask" → UI prompt
    │       ├── User chooses → save rule if "always"
    │       └── Return grant/deny
    │
    └── Return permission decision to tool executor
```
---

## 5. Session Flow

```
SessionStore.create({ workingDir, model, parentSessionId? })
    │
    ├── Generate sessionId (UUID)
    ├── Insert into database: sessions table
    ├── Return session object
    │
    └── Conversation stored as turns in database
         └── turn: { id, sessionId, role, content, toolCalls?, toolResults? }
```

---

## 6. Model/Provider Flow

```
ProviderRegistry(config)
    │
    ├── register(provider) — built-in: ollama, openai, anthropic, google
    │
    ├── getProvider(modelString) → parses "provider/model"
    │
    └── Provider.generate({ model, messages, tools, temperature, … })
            │
            ├── Call provider API
            │
            └── Returns { text, toolCalls?, usage? }
```

---

## 7. Key Design Invariants

1. **Subagents cannot spawn subagents** — `task` tool is filtered out in `runSubagent`
2. **Agent tools are filtered by `isToolAllowed`** — `tools: []` means all allowed; `disabledTools` removes
3. **Agent modes**: `primary` (user-selectable) vs `subagent` (task-tool only)
4. **Briefs are structured** — `aim` is required; `validateBrief` enforces minimum quality
5. **Batch tasks run in parallel** — `Promise.all` with merged report
6. **Sessions are hierarchical** — subagent sessions have `parentSessionId`
7. **Tools are registered in registries** — `baseTools` for main agent, `subagentTools` for children
8. **Events flow up** — subagent `onEvent` forwards to parent's `request.onEvent`

---

## 8. File References

| Flow | Files |
|------|-------|
| Agent loading | `packages/core/src/agent/agents.ts` |
| Tool restriction | `packages/core/src/agent/agents.ts:316` |
| isToolAllowed | `packages/schema/src/agent.ts:38` |
| Task tool | `packages/core/src/tool/task.ts` |
| Subagent runner | `packages/tui/src/app.ts:1847` |
| App init | `packages/tui/src/app.ts:330` |
| Permissions | `packages/tui/src/app.ts` (handlePermission) |

---
---

## 6. Model/Provider Flow

```
ProviderRegistry(config)
    │
    ├── For each configured provider:
    │       └── Create provider instance
    │
    ├── get(modelId) → Provider
    │       └── Match modelId to provider capability
    │
    └── Provider.chat({ messages, tools, signal, contextWindow })
├── Format messages for provider API
            ├── Send request (streaming or non-streaming)
            ├── Parse response chunks
            ├── Handle tool calls in response
            └── Return stream of: text deltas, tool calls, done
```
---

## 7. TUI / Screen Flow

```
App.start()
    │
    ├── reloadAgents() → load agents, skills
    ├── setLogLevel("warn")
    ├── screen = new Screen(stdin, stdout)
    │       ├── onData → handleInput(chunk)
    │       ├── onResize → render()
    │       └── start() → raw mode, alternate screen
    │
    ├── installSignalHandlers() (SIGINT, SIGTERM)
    ├── pushWelcome()
    ├── ensureTick()  // periodic render
    ├── render()      // draw UI
    ├── preload()     // warm model
    ├── warmIndex()   // build RAG index
    │
    └── return closePromise (waits for shutdown)
```

---

## 8. Input Handling Flow

```
handleInput(chunk)
    │
    ├── Parse key/escape sequence
    │
    ├── If in command mode (/command):
    │       ├── Parse command + args
    │       ├── commands.run(command, args)
    │       └── return
    │
    ├── If in input mode:
    │       ├── Buffer input
    │       ├── On Enter: submit prompt
    │       │       ├── Push user message to transcript
    │       │       ├── agent.run({ ... })
    │       │       │       ├── onEvent → push to transcript
    │       │       └── On done: push assistant message
    │       └── On Escape: clear buffer
    │
    └── scheduleRender()
```
├── ensureTick() → starts 100ms render loop
    ├── main loop: while (!exiting) { await waitForEvent() }
    │       ├── handleInput: keys → commands, text input, etc.
    │       ├── handleAgentTurn: if agent running, process events
    │       └── render: compose blocks → screen.write()
    │
    └── onExit: screen.stop(), save session, flush logs
```
---

## 8. Command Flow

```
User types "/" → handleCommand(input)
    │
    ├── Parse: /command [args...]
    │
    ├── commands.get(commandName) → CommandDefinition
    │       ├── builtin: help, agent, model, theme, clear, etc.
    │       └── custom: from .imurun/commands/
    │
    ├── If command has handler:
    │       └── await handler(args, ctx) where ctx = { app, session, screen }
    │
    ├── Some commands trigger agent actions:
    │       ├── /agent <id> → app.agent = getAgent(agents, id)
    │       ├── /model <id> → app.modelRef = id
    │       └── /clear → new session
    │
    └── Return result or error message
```

---

## 9. Skills Flow

```
loadSkills({ workingDir })
    │
    ├── Builtin skills (core)
    │
    ├── Global skills (~/.imurun/skills/*.md)
    │
    ├── Project skills (<workingDir>/.imurun/skills/*.md) — override
    │
    └── Each skill:
            ├── parse frontmatter (id, name, description, tools)
            ├── body → prompt
            └── register as tool: createSkillTool(skill)
```

---

## 10. Tool Registry Flow

```
ToolRegistry.default()
    │
    ├── Register all builtin tools:
    │       ├── read, write, edit, shell, glob, grep, code_search
    │       ├── web_search, web_fetch
    │       ├── memory, progress, todo, plan
    │       ├── task (added separately in App)
    │       └── ...
    │
    ├── list() → all registered tools
    ├── get(name) → tool definition
    └── register(tool) → add/replace
```
│
    └── If unknown: push error "unknown command"
```