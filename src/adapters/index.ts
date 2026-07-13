import type { AgentKind } from '../types'
import type { CodeAgentAdapter } from './base'
import { ClaudeAdapter } from './claude'
import { CodexAdapter } from './codex'
import { HermesAdapter } from './hermes'
import { OpenClawAdapter } from './openclaw'
import { OpenCodeAdapter } from './opencode'

const adapters: CodeAgentAdapter[] = [
    new HermesAdapter(),
    new OpenClawAdapter(),
    new ClaudeAdapter(),
    new OpenCodeAdapter(),
    new CodexAdapter()
]

export function getAdapter(kind: AgentKind): CodeAgentAdapter {
    const item = adapters.find((a) => a.kind === kind)
    if (!item) throw new Error(`Unknown agent: ${kind}`)
    return item
}

export function listAdapters() {
    return adapters
}

export * from './base'
