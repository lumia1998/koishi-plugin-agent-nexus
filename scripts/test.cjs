const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-nexus-test-'))
const outfile = path.join(outdir, 'security.test.cjs')

try {
    esbuild.buildSync({
        entryPoints: [path.join(root, 'test/security.test.mts')],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        outfile
    })
    const result = spawnSync(process.execPath, ['--test', outfile], {
        cwd: root,
        stdio: 'inherit'
    })
    process.exitCode = result.status ?? 1
} finally {
    fs.rmSync(outdir, { recursive: true, force: true })
}
