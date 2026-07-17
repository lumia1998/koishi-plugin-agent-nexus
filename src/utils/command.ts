export function parseInteractiveCommandInput(
    prompt: unknown,
    quitOption?: boolean
) {
    const raw = String(prompt ?? '').trim()
    const inlineQuit = /(?:^|\s)-q\s*$/.test(raw)
    return {
        input: inlineQuit ? raw.replace(/(?:^|\s)-q\s*$/, '').trim() : raw,
        quit: Boolean(quitOption || inlineQuit)
    }
}

