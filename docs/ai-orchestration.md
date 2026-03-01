# AI Orchestration: Approach & Comparisons

## How inbox-zero orchestrates AI steps

The project uses **Vercel AI SDK** as the sole LLM library with no orchestration framework. AI steps are coordinated through plain TypeScript async/await chains and `Promise.all()` — no LangChain, LlamaIndex, or LangGraph.

See [ai-processing.md](ai-processing.md) for the full pipeline diagram.

### Sequential steps — explicit await chains

```ts
// apps/web/utils/ai/choose-rule/run-rules.ts
const rules   = await findMatchingRules(...)
const status  = await determineConversationStatus(...)
const draft   = await fetchMessagesAndGenerateDraft(...)
const args    = await aiGenerateArgs(...)
await executeAction(...)
```

### Parallel steps — Promise.all for independent calls

```ts
// apps/web/utils/reply-tracker/generate-draft.ts
const [knowledge, context, calendar, style, mcp, meetings] = await Promise.all([
  aiExtractRelevantKnowledge(...),
  aiCollectReplyContext(...),
  aiGetCalendarAvailability(...),
  getWritingStyle(...),
  mcpAgent(...),
  getMeetingContext(...),
])
```

### Resilient batching — Promise.allSettled

```ts
const results = await Promise.allSettled(
  batch.map(threadId => runAction(threadId))
)
// one failure doesn't stop the rest
```

### Agentic tool loop — Vercel AI SDK

```ts
// apps/web/utils/ai/assistant/chat.ts
await toolCallAgentStream({
  tools: { searchInbox, readEmail, createRule, saveMemory, ... },
  stopWhen: stepCountIs(10),   // prevents infinite loops
})
```

---

## Comparison: inbox-zero vs LangGraph

[LangGraph](https://www.langchain.com/langgraph) is an alternative orchestration framework from LangChain that models AI workflows as explicit state machine graphs.

### Core concept

Instead of `await` chains, LangGraph defines nodes (steps) and edges (transitions) as a graph:

```ts
// Define shared state
const State = { emailStatus: null, matchedRule: null, draft: null }

// Define nodes
graph.addNode("classifyEmail",  classifyEmailFn)
graph.addNode("matchRule",      matchRuleFn)
graph.addNode("generateDraft",  generateDraftFn)
graph.addNode("executeAction",  executeActionFn)

// Fixed transitions
graph.addEdge("classifyEmail", "matchRule")
graph.addEdge("generateDraft", "executeAction")

// Conditional transitions (logic tree / branching)
graph.addConditionalEdges("matchRule", (state) => {
  if (state.needsDraft)   return "generateDraft"
  if (state.simpleAction) return "executeAction"
  return END
})
```

Each node reads from and writes to a shared state object:

```ts
async function classifyEmailFn(state) {
  const result = await llm.classify(state.emailContent)
  return { emailStatus: result.status }  // updates shared state
}

async function matchRuleFn(state) {
  const rule = await findRule(state.emailStatus)  // reads previous node's output
  return { matchedRule: rule }
}
```

### Feature comparison

| | inbox-zero | LangGraph |
|---|---|---|
| Sequence definition | Plain `await` chains | Nodes + edges declared as a graph |
| Branching logic | `if/else` inside functions | `addConditionalEdges()` — visible in graph |
| Parallel calls | `Promise.all()` | Parallel node fan-out |
| State passing | Function return values | Shared state object updated by each node |
| Cycles / loops | Manual recursion | Native — edges can point back to earlier nodes |
| Visualization | Manual (see ai-processing.md) | Built-in graph visualization |
| Pause & resume | Not supported | Built-in — pause mid-graph, wait for human approval, resume |
| Failure recovery | Retry per LLM call | Checkpoint entire graph state, resume from any node |
| Observability | Logging + Tinybird | LangSmith — every node, transition, and state tracked |
| Complexity | Low — just TypeScript | Higher — graph DSL to learn |

### When to choose LangGraph over plain async/await

| Scenario | Recommendation |
|---|---|
| Simple linear pipeline | Plain `await` — LangGraph adds unnecessary overhead |
| Complex branching with many conditional paths | LangGraph — graph edges make logic visible |
| Cycles (re-classify if confidence is low, retry with different prompt) | LangGraph — native support |
| Human-in-the-loop (pause for approval, then resume) | LangGraph — built-in checkpoint/resume |
| Need full observability of every step and state change | LangGraph + LangSmith |
| Small team, want simplicity | Plain `await` |

### TL;DR

| | Style |
|---|---|
| **inbox-zero** | **Imperative** — write the sequence as code (`await step1`, `await step2`) |
| **LangGraph** | **Declarative** — describe the graph, LangGraph runs it |

LangGraph pays off when you have complex branching, cycles, or need visibility into the full execution state at every step. For linear or lightly-branched pipelines, plain `async/await` is simpler and easier to debug.

---

## Related

- [AI Processing Pipeline](ai-processing.md) — full multi-step pipeline diagram for inbox-zero
- [Knowledge Base](knowledge-base.md) — how the knowledge base fits into draft generation
- [LangGraph docs](https://docs.langchain.com/oss/python/langgraph/overview)
- [Vercel AI SDK docs](https://sdk.vercel.ai)
