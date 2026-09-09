import readline from 'node:readline'

const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line)
    if (request.method === 'initialize') {
        send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, agentCapabilities: {} } })
    } else if (request.method === 'session/new') {
        send({ id: request.id, result: { sessionId: 'compat-session' } })
    } else if (request.method === 'session/prompt') {
        for (let index = 0; index < 20; index++) {
            send({ method: 'session/update', params: { sessionId: 'compat-session', update: {
                sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `part-${index}\n` }
            } } })
        }
        send({ id: request.id, result: { stopReason: 'end_turn' } })
    }
})
