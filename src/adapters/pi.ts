import { CodeAgentAdapter, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

/** Adapter for the pi-mono coding agent CLI. */
export class PiAdapter extends CodeAgentAdapter {
    readonly kind = 'pi' as const
    readonly binNames = ['pi']

    skillDirs(home: string) {
        return [`${home}/.pi/agent/skills`, `${home}/.pi/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const parts = [this.executable(options, 'pi')]
        if (options.sessionMode === 'managed') {
            parts.push('--mode', 'json')
            const sessionId = providerSessionId(options.providerState)
            if (sessionId) parts.push('--session', quoteShell(sessionId))
        } else {
            parts.push('-p', '--no-session')
        }
        if (options.model) parts.push('--model', quoteShell(options.model))
        parts.push(promptExpr)
        return parts.join(' ')
    }

    parseResult(
        stdout: string,
        stderr: string,
        exitCode: number,
        timedOut: boolean,
        command: string
    ) {
        const json = command.includes('--mode json') ? parsePiJsonOutput(stdout) : undefined
        const result = super.parseResult(
            json?.text || stdout,
            stderr,
            exitCode,
            timedOut,
            command
        )
        result.raw = stdout || stderr
        if (json?.sessionId) result.providerState = { sessionId: json.sessionId }
        return result
    }

    protected parseText(stdout: string, stderr: string) {
        return stdout.trim() || stderr.trim()
    }
}

export function parsePiJsonOutput(stdout: string) {
    let sessionId: string | undefined
    let text = ''
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue
        let event: any
        try {
            event = JSON.parse(line)
        } catch {
            continue
        }
        if (event?.type === 'session' && typeof event.id === 'string' && event.id.trim()) {
            sessionId = event.id.trim()
        }
        if (event?.type === 'message_end' || event?.type === 'turn_end') {
            const candidate = assistantText(event.message)
            if (candidate) text = candidate
        }
        if (event?.type === 'agent_end' && Array.isArray(event.messages)) {
            for (const message of event.messages) {
                const candidate = assistantText(message)
                if (candidate) text = candidate
            }
        }
    }
    return sessionId || text ? { sessionId, text } : undefined
}

function assistantText(message: any) {
    if (!message || message.role !== 'assistant') return ''
    if (typeof message.content === 'string') return message.content.trim()
    if (!Array.isArray(message.content)) return ''
    return message.content
        .flatMap((item: any) =>
            typeof item === 'string'
                ? [item]
                : item?.type === 'text' && typeof item.text === 'string'
                  ? [item.text]
                  : []
        )
        .join('\n')
        .trim()
}

function providerSessionId(state: DelegateOptions['providerState']) {
    return typeof state?.sessionId === 'string' && state.sessionId.trim()
        ? state.sessionId.trim()
        : undefined
}
