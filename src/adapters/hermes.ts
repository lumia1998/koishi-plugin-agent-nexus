import { CodeAgentAdapter, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class HermesAdapter extends CodeAgentAdapter {
    readonly kind = 'hermes' as const
    readonly binNames = ['hermes']

    skillDirs(home: string) {
        return [`${home}/.hermes/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        if (options.sessionMode === 'managed') {
            const sessionId = providerSessionId(options.providerState)
            const sessionArg = sessionId
                ? ` --resume ${quoteShell(sessionId)}`
                : ' --source agent-nexus'
            return `hermes chat --quiet --yolo${sessionArg} -q ${promptExpr}`
        }
        return `hermes -z ${promptExpr}`
    }

    parseResult(
        stdout: string,
        stderr: string,
        exitCode: number,
        timedOut: boolean,
        command: string
    ) {
        const result = super.parseResult(
            stdout,
            stderr,
            exitCode,
            timedOut,
            command
        )
        const sessionId = extractHermesSessionId(stderr)
        if (sessionId) result.providerState = { sessionId }
        return result
    }
}

export function extractHermesSessionId(stderr: string) {
    let sessionId: string | undefined
    for (const line of stderr.split(/\r?\n/)) {
        const match = line.match(/^session_id:\s*(\S+)\s*$/)
        if (match) sessionId = match[1]
    }
    return sessionId
}

function providerSessionId(state: DelegateOptions['providerState']) {
    return typeof state?.sessionId === 'string' && state.sessionId.trim()
        ? state.sessionId.trim()
        : undefined
}
