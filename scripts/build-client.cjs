const fs = require('fs')
const path = require('path')

function toDriveRoot(input) {
    const abs = path.resolve(input)
    // Prefer an existing mapped drive because Vite cannot reliably load Vue files from UNC roots.
    const m = abs.match(/^[\\/]{2}[^\\/]+[\\/]code_workspace[\\/]?(.*)$/i)
    if (m) {
        for (const drive of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
            const mapped = path.resolve(`${drive}:\\` + (m[1] || ''))
            if (fs.existsSync(path.join(mapped, 'client', 'index.ts'))) return mapped
        }
    }
    return abs
}

function resolveRoot() {
    const candidates = [
        process.env.INIT_CWD,
        process.cwd(),
        path.resolve(__dirname, '..')
    ].filter(Boolean)

    for (const candidate of candidates) {
        const mapped = toDriveRoot(candidate)
        if (fs.existsSync(path.join(mapped, 'client', 'index.ts'))) return mapped
    }
    return toDriveRoot(path.resolve(__dirname, '..'))
}

const root = resolveRoot()

function findElementPlus(dir, depth = 0) {
    if (depth > 6) return null
    let entries = []
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return null
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const full = path.join(dir, entry.name)
        if (
            entry.name === 'element-plus' &&
            fs.existsSync(path.join(full, 'package.json')) &&
            fs.existsSync(path.join(full, 'es', 'index.mjs'))
        ) {
            return full
        }
        if (
            entry.name === 'node_modules' ||
            entry.name.startsWith('@') ||
            entry.name.startsWith('.')
        ) {
            const found = findElementPlus(full, depth + 1)
            if (found) return found
        }
    }
    return null
}

function resolveElementPlusEntry(dir) {
    return path.join(dir, 'es', 'index.mjs')
}

async function main() {
    process.chdir(root)
    console.log('client root:', root)

    const clientLib = path.join(root, 'node_modules', '@koishijs', 'client', 'lib')
    const { build } = require(clientLib)

    const elementPlusDir = findElementPlus(path.join(root, 'node_modules'))
    if (!elementPlusDir) {
        throw new Error(
            'element-plus not found under node_modules. Install @koishijs/client / console deps first.'
        )
    }
    const elementPlusEntry = resolveElementPlusEntry(elementPlusDir)
    if (!elementPlusEntry) {
        throw new Error(`element-plus entry missing under ${elementPlusDir}`)
    }
    console.log('element-plus:', elementPlusEntry)

    // Keep chatluna style: Element comes from Console host tree, not a direct package dep.
    await build(root, {
        resolve: {
            alias: {
                'element-plus': elementPlusEntry
            }
        }
    })

    const indexJs = path.join(root, 'dist', 'index.js')
    if (!fs.existsSync(indexJs)) {
        throw new Error('client build finished without dist/index.js')
    }
    console.log('client build ok ->', indexJs)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
