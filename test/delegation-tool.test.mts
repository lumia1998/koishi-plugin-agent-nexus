import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildDelegationToolNames,
    delegationToolNameForJob,
    type DelegationJob
} from '../src/delegation/index.ts'
import {
    NexusAgentDelegateTool,
    NexusTaskTool,
    registerAgentDelegationTools
} from '../src/tools/delegate.ts'

test('builds stable, Agent-facing delegation tool names', () => {
    const names = buildDelegationToolNames([
        { id: 'hermes-route', name: 'Hermes News' },
        { id: 'opencode-route', name: 'Development OpenCode', agentId: 'opencode' },
        { id: 'pi-route', name: 'Pi', agentId: 'pi' },
        { id: 'second-opencode', name: 'Other OpenCode', agentId: 'opencode' },
        { id: 'unicode-route', name: '中文 Agent' }
    ])

    assert.equal(names.get('hermes-route'), 'nexus_hermes')
    assert.equal(names.get('opencode-route'), 'nexus_opencode')
    assert.equal(names.get('pi-route'), 'nexus_pi')
    assert.equal(names.get('second-opencode'), 'nexus_opencode_2')
    assert.equal(names.get('unicode-route'), 'nexus_agent')
})

test('persists the exact Agent tool name with a delegation job', () => {
    const job = {
        toolName: 'nexus_opencode_2',
        agentId: 'route-2',
        agentName: 'Other OpenCode',
        providerAgentId: 'opencode'
    } as Pick<DelegationJob, 'toolName' | 'agentId' | 'agentName' | 'providerAgentId'>
    assert.equal(delegationToolNameForJob(job), 'nexus_opencode_2')
})

test('an Agent-specific tool fixes routing and hides the remote field', async () => {
    let invocation: any
    const nexus = {
        async handleDelegate(input: unknown, context: unknown, signal: unknown) {
            invocation = { input, context, signal }
            return 'delegated'
        }
    }
    const tool = new NexusAgentDelegateTool(
        nexus as any,
        'hermes-route',
        'Hermes',
        'nexus_hermes'
    )

    assert.equal((tool.schema as any).shape.remote, undefined)
    const result = await tool._call(
        { action: 'run', prompt: 'clone the project' },
        undefined,
        {
            configurable: {
                conversationId: 'conversation-1',
                userId: 'user-1',
                session: { platform: 'test', selfId: 'bot', userId: 'user-1' }
            },
            signal: new AbortController().signal
        }
    )

    assert.equal(result, 'delegated')
    assert.deepEqual(invocation.input, {
        action: 'run',
        prompt: 'clone the project',
        remote: 'hermes-route'
    })
    assert.equal((invocation.context as any).parentConversationId, 'conversation-1')
})

test('an Agent-specific tool works without conversation context', async () => {
    let invocation: any
    const nexus = {
        async handleDelegate(input: unknown, context: unknown) {
            invocation = { input, context }
            return 'delegated without context'
        }
    }
    const tool = new NexusAgentDelegateTool(
        nexus as any,
        'hermes-route',
        'Hermes',
        'nexus_hermes'
    )

    const result = await tool._call({ action: 'run', prompt: '原样发送' })
    assert.equal(result, 'delegated without context')
    assert.equal(invocation.context, undefined)
    assert.deepEqual(invocation.input, {
        action: 'run',
        prompt: '原样发送',
        remote: 'hermes-route'
    })
})

test('the unified nexus_task tool exposes ChatLuna-style task routing', async () => {
    let invocation: any
    const nexus = {
        async handleDelegate(input: unknown) {
            invocation = input
            return 'delegated'
        }
    }
    const tool = new NexusTaskTool(nexus as any)
    assert.equal(
        await tool._call({
            action: 'message',
            agent: 'hermes',
            id: 'task-1',
            requestId: 'request-1',
            optionId: 'allow_once'
        }),
        'delegated'
    )
    assert.deepEqual(invocation, {
        action: 'message',
        agent: 'hermes',
        id: 'task-1',
        requestId: 'request-1',
        optionId: 'allow_once',
        remote: 'hermes'
    })

    await tool._call({
        action: 'publish',
        agent: 'hermes',
        id: 'task-1',
        path: 'dist/report.md'
    })
    assert.deepEqual(invocation, {
        action: 'publish',
        agent: 'hermes',
        id: 'task-1',
        path: 'dist/report.md',
        remote: 'hermes'
    })
})

test('forwards current Koishi message attachments only for task turns', async () => {
    let invocation: any
    const nexus = {
        async collectInputAttachments(parentConfig: any) {
            assert.equal(parentConfig.configurable.session.elements[0].type, 'img')
            return [{
                name: '需求.png',
                mediaType: 'image/png',
                bytes: new Uint8Array([1, 2, 3])
            }]
        },
        async handleDelegate(input: unknown) {
            invocation = input
            return 'delegated'
        }
    }
    const tool = new NexusAgentDelegateTool(
        nexus as any,
        'hermes-route',
        'Hermes',
        'nexus_hermes'
    )

    await tool._call(
        { action: 'run', prompt: '分析这张图片' },
        undefined,
        { configurable: { session: { elements: [{ type: 'img' }] } } }
    )
    assert.equal(invocation.attachments[0].name, '需求.png')
    assert.deepEqual([...invocation.attachments[0].bytes], [1, 2, 3])

    invocation = undefined
    await tool._call(
        { action: 'status', id: 'job-1' },
        undefined,
        { configurable: { session: { elements: [{ type: 'img' }] } } }
    )
    assert.equal(invocation.attachments, undefined)
})

test('reads ChatLuna Agent context from the nested configurable field', async () => {
    let invocation: any
    const nexus = {
        async handleDelegate(input: unknown, context: unknown) {
            invocation = { input, context }
            return 'delegated'
        }
    }
    const tool = new NexusAgentDelegateTool(
        nexus as any,
        'hermes-route',
        'Hermes',
        'nexus_hermes'
    )

    await tool._call(
        { action: 'run', prompt: '后台处理', background: true },
        undefined,
        {
            configurable: {
                agentContext: {
                    conversationId: 'agent-conversation',
                    userId: 'agent-user'
                },
                session: { platform: 'test', selfId: 'bot' }
            }
        }
    )
    assert.equal(
        invocation.context.parentConversationId,
        'agent-conversation'
    )
    assert.equal(invocation.context.routing.userId, 'agent-user')
})

test('registers one tool per enabled Agent and disposes stale tools on sync', () => {
    const agents = [
        {
            id: 'hermes-route',
            name: 'Hermes News',
            provider: 'gateway',
            remoteId: 'primary-gateway',
            remoteName: 'Nexus Gateway',
            agentId: 'hermes',
            protocol: 'acp',
            enabled: true,
            state: 'ready',
            skills: []
        },
        {
            id: 'opencode-route',
            name: 'OpenCode Dev',
            provider: 'gateway',
            remoteId: 'primary-gateway',
            remoteName: 'Nexus Gateway',
            agentId: 'opencode',
            workspace: '/workspace',
            enabled: true,
            state: 'ready',
            skills: []
        },
        {
            id: 'disabled-route',
            name: 'Pi',
            provider: 'gateway',
            remoteId: 'primary-gateway',
            remoteName: 'Nexus Gateway',
            agentId: 'pi',
            workspace: '/workspace',
            enabled: false,
            state: 'error',
            skills: []
        }
    ] as any[]
    const registered = new Map<string, any>()
    const platform = {
        registerTool(name: string, spec: any) {
            registered.set(name, spec)
            return () => registered.delete(name)
        },
        unregisterTool(name: string) {
            registered.delete(name)
        }
    }
    const disposers = registerAgentDelegationTools(
        platform,
        {} as any,
        agents as any
    )
    assert.deepEqual([...registered.keys()], [
        'nexus_task',
        'nexus_hermes',
        'nexus_opencode'
    ])
    assert.doesNotMatch(registered.get('nexus_hermes').description, /A2A|ACP/)
    assert.equal(registered.has('nexus_a2a_delegate'), false)

    agents.splice(0, agents.length, agents[2])
    for (const dispose of disposers) dispose()
    assert.deepEqual([...registered.keys()], [])
})
