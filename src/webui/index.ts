import { Context } from 'koishi'
import { resolve } from 'path'
import type { AgentNexusService } from '../service'
import type { NexusConfig, SkillSourceConfig, SshHostConfig } from '../types'
import { createHost } from '../config'
import { randomUUID } from 'crypto'

export const name = 'agent-nexus-webui'
export const inject = ['console', 'agent_nexus']

export function apply(ctx: Context) {
    ctx.console.addEntry({
        dev: resolve(__dirname, '../client/index.ts'),
        prod: resolve(__dirname, '../dist')
    })

    const nexus = () => ctx.agent_nexus as AgentNexusService

    ctx.console.addListener('agent-nexus/getConfig', async () => nexus().getConfig())
    ctx.console.addListener('agent-nexus/getStatus', async () => nexus().getStatus())
    ctx.console.addListener('agent-nexus/getConsoleData', async () =>
        nexus().getConsoleData()
    )

    ctx.console.addListener('agent-nexus/saveConfig', async (cfg: NexusConfig) => {
        await nexus().saveConfig(cfg)
        return { success: true }
    })

    ctx.console.addListener('agent-nexus/saveHost', async (input: Partial<SshHostConfig>) => {
        const cfg = structuredClone(nexus().getConfig())
        if (input.id) {
            const idx = cfg.hosts.findIndex((h) => h.id === input.id)
            if (idx >= 0) cfg.hosts[idx] = { ...cfg.hosts[idx], ...input } as SshHostConfig
            else cfg.hosts.push(createHost(input))
        } else {
            cfg.hosts.push(createHost(input))
        }
        if (!cfg.defaultHostId) cfg.defaultHostId = cfg.hosts[0]?.id
        await nexus().saveConfig(cfg)
        return { success: true, hosts: cfg.hosts }
    })

    ctx.console.addListener('agent-nexus/removeHost', async (hostId: string) => {
        const cfg = structuredClone(nexus().getConfig())
        cfg.hosts = cfg.hosts.filter((h) => h.id !== hostId)
        if (cfg.defaultHostId === hostId) cfg.defaultHostId = cfg.hosts[0]?.id
        await nexus().saveConfig(cfg)
        return { success: true }
    })

    ctx.console.addListener('agent-nexus/testHost', async (hostId: string) => {
        return await nexus().testHost(hostId)
    })

    ctx.console.addListener('agent-nexus/scanAgents', async (hostId?: string) => {
        return await nexus().scanAgents(hostId)
    })

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
        }
    )

    ctx.console.addListener('agent-nexus/listSkills', async (hostId?: string) => {
        return await nexus().refreshSkills(hostId)
    })

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
            agent?: any
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
        'agent-nexus/saveConfig'(cfg: import('../types').NexusConfig): Promise<{ success: boolean }>
        'agent-nexus/saveHost'(
            input: Partial<import('../types').SshHostConfig>
        ): Promise<{ success: boolean; hosts?: import('../types').SshHostConfig[] }>
        'agent-nexus/removeHost'(hostId: string): Promise<{ success: boolean }>
        'agent-nexus/testHost'(hostId: string): Promise<{ ok: boolean; output?: string }>
        'agent-nexus/scanAgents'(hostId?: string): Promise<import('../types').NexusStatus>
        'agent-nexus/syncSkill'(input: {
            repoUrl: string
            name?: string
            branch?: string
            subdir?: string
            hostId?: string
        }): Promise<{ success: boolean; skill?: import('../types').SkillInfo }>
        'agent-nexus/listSkills'(hostId?: string): Promise<import('../types').SkillInfo[]>
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
            agent?: any
            hostId?: string
            cwd?: string
            publishFiles?: boolean
        }): Promise<any>
    }
}
