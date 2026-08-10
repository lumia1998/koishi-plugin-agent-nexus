import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

export async function writeTextFileAtomic(
    filePath: string,
    content: string,
    mode?: number
) {
    await mkdir(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
    try {
        await writeFile(
            tempPath,
            content,
            mode === undefined
                ? { encoding: 'utf8' }
                : { encoding: 'utf8', mode }
        )
        await renameWithRetry(tempPath, filePath)
    } catch (error) {
        await unlink(tempPath).catch(() => undefined)
        throw error
    }
}

export async function moveCorruptFileAside(filePath: string) {
    const backupPath = `${filePath}.corrupt-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')}`
    await renameWithRetry(filePath, backupPath)
    return backupPath
}

export async function renameWithRetry(source: string, target: string) {
    const delays = [0, 25, 75, 150]
    let lastError: unknown
    for (const delay of delays) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        try {
            await rename(source, target)
            return
        } catch (error) {
            lastError = error
            const code = (error as NodeJS.ErrnoException).code
            if (!code || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) {
                throw error
            }
        }
    }
    throw lastError
}
