import { Context } from 'koishi'
import { resolve } from 'path'
import type { AgentNexusService } from '../service'
import { contentDisposition, sendCachedFile } from './artifact-http'
import type { DelegationAgentConfig } from '../types'

export const name = 'agent-nexus-webui'
export const inject = ['console', 'agent_nexus', 'server']

export function apply(ctx: Context) {
    ctx.console.addEntry({
        dev: resolve(__dirname, '../client/index.ts'),
        prod: resolve(__dirname, '../dist')
    })

    const nexus = () => ctx.agent_nexus as AgentNexusService
    const commandAuthority = { authority: nexus().commandAuthority }

    // This route is a raw Koa handler, so it sits outside the Console login:
    // the signed ticket in the URL is what gates access. Cached artifacts are
    // streamed from disk, which keeps the artifact bytes out of the heap and
    // lets the browser issue Range requests for audio/video previews.
    // The console registers `/(.*)` as an SPA fallback but defers to any route
    // registered after it, so this handler wins for its own path.
    ctx.server?.get(
        '/agent-nexus/artifacts/:jobId/:artifactId',
        async (koa: any) => {
            try {
                const artifact = await nexus().readDelegationArtifact(
                    koa.params.jobId,
                    koa.params.artifactId,
                    String(koa.query?.ticket || '')
                )
                koa.set('Cache-Control', 'private, no-store')
                koa.set(
                    'Content-Disposition',
                    contentDisposition(artifact.name, koa.query?.inline === '1')
                )
                koa.type = artifact.mediaType || 'application/octet-stream'
                if (artifact.kind === 'file') {
                    return sendCachedFile(koa, artifact.path, artifact.size)
                }
                koa.status = 200
                koa.body = Buffer.from(artifact.bytes)
            } catch (error) {
                koa.status = 403
                koa.type = 'text/plain; charset=utf-8'
                koa.body = error instanceof Error ? error.message : String(error)
            }
        }
    )

    ctx.console.addListener('agent-nexus/getConsoleData', async () =>
        nexus().getConsoleData()
    )
    ctx.console.addListener(
        'agent-nexus/listDelegationJobs',
        async (limit?: number) => nexus().listDelegationJobs(limit),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/cancelDelegationJob',
        async (id: string) => nexus().cancelDelegationJob(id),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/clearTerminalDelegationJobs',
        async () => nexus().clearTerminalDelegationJobs(),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/clearArtifactCache',
        async () => nexus().clearArtifactCache(),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/createArtifactTicket',
        async (jobId: string, artifactId: string) =>
            nexus().createArtifactTicket(jobId, artifactId),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/refreshGateway',
        async () => nexus().refreshRemoteStatuses(),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/saveDelegationAgent',
        async (input: Partial<DelegationAgentConfig>) =>
            nexus().saveDelegationAgent(input),
        commandAuthority
    )
    ctx.console.addListener(
        'agent-nexus/removeDelegationAgent',
        async (agentId: string) => nexus().removeDelegationAgent(agentId),
        commandAuthority
    )
}

declare module '@koishijs/plugin-console' {
    interface Events {
        'agent-nexus/getConsoleData'(): Promise<import('../types').NexusConsoleData>
        'agent-nexus/listDelegationJobs'(
            limit?: number
        ): Promise<import('../delegation/types').DelegationJobView[]>
        'agent-nexus/cancelDelegationJob'(id: string): Promise<string>
        'agent-nexus/clearTerminalDelegationJobs'(): Promise<number>
        'agent-nexus/clearArtifactCache'(): Promise<number>
        'agent-nexus/refreshGateway'(): Promise<import('../types').NexusStatus>
        'agent-nexus/createArtifactTicket'(
            jobId: string,
            artifactId: string
        ): Promise<{
            url: string
            name: string
            mediaType?: string
            expiresAt: number
        }>
        'agent-nexus/saveDelegationAgent'(
            input: Partial<import('../types').DelegationAgentConfig>
        ): Promise<{
            agentId: string
            data: import('../types').NexusConsoleData
        }>
        'agent-nexus/removeDelegationAgent'(
            agentId: string
        ): Promise<import('../types').NexusConsoleData>
    }
}
