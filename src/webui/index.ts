import { Context } from 'koishi'
import { resolve } from 'path'
import type { AgentNexusService } from '../service'
import type {
    AgentKind,
    NexusConfig,
    SkillSourceConfig,
    SshHostConfig
} from '../types'
import { randomUUID } from 'crypto'
import type { SessionHistoryQuery } from '../sessions/types'

export const name = 'agent-nexus-webui'
export const inject = ['console', 'agent_nexus']

export function apply(ctx: Context) {
    ctx.console.addEntry({
        dev: resolve(__dirname, '../client/index.ts'),
        prod: resolve(__dirname, '../dist')
    })

    const nexus = () => ctx.agent_nexus as AgentNexusService
    const commandAuthority = { authority: nexus().commandAuthority }

    ctx.console.addListener('agent-nexus/getConfig', async () => nexus().getConfig())
    ctx.console.addListener('agent-nexus/getStatus', async () => nexus().getStatus())
    ctx.console.addListener('agent-nexus/getConsoleData', async () =>
        nexus().getConsoleData()
    )

    ctx.console.addListener(
        'agent-nexus/listSessionHistory',
        async (query: SessionHistoryQuery = {}) =>
            nexus().listSessionHistory(query),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/getSessionHistory',
        async (id: string) => nexus().getSessionHistory(id),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/deleteSessionHistory',
        async (id: string) => nexus().deleteSessionHistory(id),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/retrySessionSummary',
        async (id: string) => nexus().retrySessionSummary(id),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/saveConfig',
        async (cfg: NexusConfig) => {
            await nexus().saveConfig(cfg)
            return { success: true }
        },
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/saveHost',
        async (input: Partial<SshHostConfig> & { setAsDefault?: boolean }) => {
            const result = await nexus().saveHost(input)
            return { success: true, hostId: result.hostId, data: result.data }
        },
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/removeHost',
        async (hostId: string) => {
            await nexus().removeHost(hostId)
            return { success: true }
        },
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/testHost',
        async (hostId: string) => await nexus().testHost(hostId),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/scanAgents',
        async (hostId?: string) => await nexus().scanAgents(hostId),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/maintainAgent',
        async (input: import('../types').AgentMaintenanceInput) =>
            nexus().maintainAgent(input),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/syncSkill',
        async (input: {
            repoUrl: string
            name?: string
            branch?: string
            subdir?: string
            hostId?: string
        }) => {
            const source: SkillSourceConfig = {
                id: randomUUID(),
                name: input.name || '',
                repoUrl: input.repoUrl,
                branch: input.branch,
                subdir: input.subdir,
                enabled: true
            }
            const info = await nexus().syncSkill(source, input.hostId)
            return { success: true, skill: info }
        },
        commandAuthority
    )

    ctx.console.addListener('agent-nexus/listSkills', async (hostId?: string) => {
        return await nexus().refreshSkills(hostId)
    })

    ctx.console.addListener(
        'agent-nexus/listFiles',
        async (input: { hostId?: string; path?: string } = {}) =>
            nexus().listRemoteFiles(input),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/previewFile',
        async (input: { hostId?: string; path: string }) =>
            nexus().previewRemoteFile(input),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/uploadFile',
        async (input: {
            hostId?: string
            path: string
            contentBase64: string
        }) => nexus().uploadRemoteFile(input),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/saveTextFile',
        async (input: { hostId?: string; path: string; content: string }) =>
            nexus().saveRemoteText(input),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/createDirectory',
        async (input: { hostId?: string; parent: string; name: string }) =>
            nexus().createRemoteDirectory(input),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/renameFile',
        async (input: { hostId?: string; path: string; newName: string }) =>
            nexus().renameRemoteFile(input),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/deleteFile',
        async (input: { hostId?: string; path: string }) =>
            nexus().deleteRemoteFile(input),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/downloadFile',
        async (input: { hostId?: string; path: string }) =>
            nexus().downloadRemoteFile(input),
        commandAuthority
    )

    ctx.console.addListener(
        'agent-nexus/openTerminal',
        async function (
            this: { id: string },
            input: { hostId?: string; cols?: number; rows?: number; cwd?: string } = {}
        ) {
            return await nexus().createTerminal(this.id || 'console', input)
        }
    )

    ctx.console.addListener(
        'agent-nexus/closeTerminal',
        async (sessionId: string, terminalId: string) => {
            await nexus().closeTerminal(sessionId, terminalId)
            return { success: true }
        }
    )

    ctx.console.addListener(
        'agent-nexus/delegate',
        async (input: {
            prompt: string
            agent?: AgentKind | 'auto'
            hostId?: string
            cwd?: string
            publishFiles?: boolean
        }) => {
            return await nexus().delegate(input)
        }
    )
}

declare module '@koishijs/plugin-console' {
    interface Events {
        'agent-nexus/getConfig'(): Promise<import('../types').NexusConfig>
        'agent-nexus/getStatus'(): Promise<import('../types').NexusStatus>
        'agent-nexus/getConsoleData'(): Promise<import('../types').NexusConsoleData>
        'agent-nexus/listSessionHistory'(
            query?: import('../sessions/types').SessionHistoryQuery
        ): Promise<import('../sessions/types').SessionHistoryPage>
        'agent-nexus/getSessionHistory'(
            id: string
        ): Promise<import('../sessions/types').SessionHistoryDetail>
        'agent-nexus/deleteSessionHistory'(
            id: string
        ): Promise<{ success: boolean }>
        'agent-nexus/retrySessionSummary'(
            id: string
        ): Promise<{ success: boolean }>
        'agent-nexus/saveConfig'(cfg: import('../types').NexusConfig): Promise<{ success: boolean }>
        'agent-nexus/saveHost'(
            input: Partial<import('../types').SshHostConfig> & { setAsDefault?: boolean }
        ): Promise<{
            success: boolean
            hostId: string
            data: import('../types').NexusConsoleData
        }>
        'agent-nexus/removeHost'(hostId: string): Promise<{ success: boolean }>
        'agent-nexus/testHost'(hostId: string): Promise<{ ok: boolean; output?: string }>
        'agent-nexus/scanAgents'(hostId?: string): Promise<import('../types').NexusStatus>
        'agent-nexus/maintainAgent'(
            input: import('../types').AgentMaintenanceInput
        ): Promise<import('../types').AgentMaintenanceResult>
        'agent-nexus/syncSkill'(input: {
            repoUrl: string
            name?: string
            branch?: string
            subdir?: string
            hostId?: string
        }): Promise<{ success: boolean; skill?: import('../types').SkillInfo }>
        'agent-nexus/listSkills'(hostId?: string): Promise<import('../types').SkillInfo[]>
        'agent-nexus/listFiles'(input?: {
            hostId?: string
            path?: string
        }): Promise<import('../types').RemoteFileListing>
        'agent-nexus/previewFile'(input: {
            hostId?: string
            path: string
        }): Promise<import('../types').RemoteFilePreview>
        'agent-nexus/uploadFile'(input: {
            hostId?: string
            path: string
            contentBase64: string
        }): Promise<{ success: boolean; path: string }>
        'agent-nexus/saveTextFile'(input: {
            hostId?: string
            path: string
            content: string
        }): Promise<{ success: boolean; path: string }>
        'agent-nexus/createDirectory'(input: {
            hostId?: string
            parent: string
            name: string
        }): Promise<{ success: boolean; path: string }>
        'agent-nexus/renameFile'(input: {
            hostId?: string
            path: string
            newName: string
        }): Promise<{ success: boolean; path: string }>
        'agent-nexus/deleteFile'(input: {
            hostId?: string
            path: string
        }): Promise<{ success: boolean }>
        'agent-nexus/downloadFile'(input: {
            hostId?: string
            path: string
        }): Promise<import('../types').RemoteFileDownload>
        'agent-nexus/openTerminal'(input?: {
            hostId?: string
            cols?: number
            rows?: number
            cwd?: string
        }): Promise<import('../types').TerminalInfo>
        'agent-nexus/closeTerminal'(
            sessionId: string,
            terminalId: string
        ): Promise<{ success: boolean }>
        'agent-nexus/delegate'(input: {
            prompt: string
            agent?: import('../types').AgentKind | 'auto'
            hostId?: string
            cwd?: string
            publishFiles?: boolean
        }): ReturnType<import('../service').AgentNexusService['delegate']>
    }
}
