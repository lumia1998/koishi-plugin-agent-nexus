import { randomUUID } from 'crypto'
import type { AgentKind, NexusConfig, SkillInfo, SkillSourceConfig } from '../types'
import type { SshSession } from '../ssh/session'
import { getAdapter, listAdapters } from '../adapters'
import { quoteShell } from '../utils/shell'
import {
    validateGitRef,
    validatePathSegment,
    validateRepoUrl,
    validateSkillSubdir
} from '../utils/security'

const NEXUS_MARKER = '<nexus_files>'

export function appendFileHint(prompt: string) {
    if (prompt.includes(NEXUS_MARKER)) return prompt
    return `${prompt.trim()}

完成后：
1) 把最终答案写在最后
2) 仅当产生文件或图片时，用绝对路径列出：
${NEXUS_MARKER}
/abs/path/to/file
</nexus_files>
没有产生文件时不要输出上述标签。`
}

export async function syncSkillSource(
    session: SshSession,
    source: SkillSourceConfig,
    config: NexusConfig,
    enabledAgents: AgentKind[]
): Promise<SkillInfo> {
    const root = config.skillRoot
    const name = validatePathSegment(source.name || guessName(source.repoUrl), 'skill name')
    const sourceId = validatePathSegment(source.id || name, 'skill source id')
    const branch = validateGitRef(source.branch || 'main')
    const repoUrl = validateRepoUrl(source.repoUrl)
    const sub = validateSkillSubdir(source.subdir)

    const script = [
        `set -e`,
        `ROOT=$(printf %s ${quoteShell(root)} | sed "s|^~|$HOME|")`,
        `REPOS="$ROOT/../repos"`,
        `REPO="$REPOS/${sourceId}"`,
        `SKILL="$ROOT/${name}"`,
        `STAGE="$ROOT/.${name}.stage.$$"`,
        `BACKUP="$ROOT/.${name}.backup.$$"`,
        `trap 'rm -rf "$STAGE" "$BACKUP"' EXIT`,
        `mkdir -p "$REPOS" "$ROOT"`,
        `if [ -d "$REPO/.git" ]; then`,
        `  git -C "$REPO" fetch --depth 1 origin ${quoteShell(branch)}`,
        `  git -C "$REPO" checkout -B ${quoteShell(branch)} FETCH_HEAD`,
        `else`,
        `  rm -rf "$REPO"`,
        `  git clone --depth 1 --branch ${quoteShell(branch)} ${quoteShell(repoUrl)} "$REPO" || git clone --depth 1 ${quoteShell(repoUrl)} "$REPO"`,
        `fi`,
        sub
            ? `SRC="$REPO/${sub}"`
            : `SRC="$REPO"`,
        `if [ ! -f "$SRC/SKILL.md" ] && [ -d "$SRC" ]; then`,
        `  FOUND=$(find "$SRC" -maxdepth 3 -type f -name SKILL.md | head -n 1 || true)`,
        `  if [ -n "$FOUND" ]; then SRC=$(dirname "$FOUND"); fi`,
        `fi`,
        `[ -f "$SRC/SKILL.md" ] || { echo "SKILL.md not found" >&2; exit 1; }`,
        `rm -rf "$STAGE" "$BACKUP"`,
        `mkdir -p "$STAGE"`,
        `cp -a "$SRC"/. "$STAGE"/`,
        `[ -f "$STAGE/SKILL.md" ] || { echo "Skill staging failed" >&2; exit 1; }`,
        `if [ -e "$SKILL" ]; then mv "$SKILL" "$BACKUP"; fi`,
        `if mv "$STAGE" "$SKILL"; then rm -rf "$BACKUP"; else [ ! -e "$BACKUP" ] || mv "$BACKUP" "$SKILL"; exit 1; fi`,
        `printf %s "$SKILL"`
    ].join('\n')

    const result = await session.exec(script, { timeoutMs: 300000 })
    if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || 'skill sync failed')
    }

    const path = result.stdout.trim().split('\n').pop() || `${root}/${name}`
    const linked = await linkSkillToAgents(session, path, name, enabledAgents)

    return {
        id: source.id || randomUUID(),
        name,
        sourceId: source.id,
        path,
        linkedAgents: linked
    }
}

export async function linkSkillToAgents(
    session: SshSession,
    skillPath: string,
    skillName: string,
    agents: AgentKind[]
): Promise<AgentKind[]> {
    const linked: AgentKind[] = []
    for (const kind of agents) {
        for (const dirTpl of getAdapter(kind).skillDirs('~')) {
            const simple = [
                `DIR=$(echo ${quoteShell(dirTpl)} | sed "s|^~|$HOME|")`,
                `mkdir -p "$DIR"`,
                `ln -sfn ${quoteShell(skillPath)} "$DIR/${validatePathSegment(skillName, 'skill name')}"`
            ].join(' && ')

            const res = await session.exec(simple, { timeoutMs: 15000 })
            if (res.exitCode === 0) {
                linked.push(kind)
                break
            }
        }
    }
    return Array.from(new Set(linked))
}

export async function listRemoteSkills(
    session: SshSession,
    config: NexusConfig,
    agents: AgentKind[] = []
): Promise<SkillInfo[]> {
    const root = config.skillRoot
    const res = await session.exec(
        [
            `ROOT=$(echo ${quoteShell(root)} | sed "s|^~|$HOME|")`,
            `mkdir -p "$ROOT"`,
            `for d in "$ROOT"/*; do`,
            `  [ -d "$d" ] || continue`,
            `  name=$(basename "$d")`,
            `  printf '%s\\t%s\\n' "$name" "$d"`,
            `done`
        ].join('\n'),
        { timeoutMs: 15000 }
    )

    if (res.exitCode !== 0) return []

    const skills = res.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [name, path] = line.split('\t')
            return {
                id: name,
                name,
                path: path || name,
                linkedAgents: [] as AgentKind[]
            }
        })

    for (const skill of skills) {
        skill.linkedAgents = await findLinkedAgents(session, skill.path, skill.name, agents)
    }
    return skills
}

async function findLinkedAgents(
    session: SshSession,
    skillPath: string,
    skillName: string,
    agents: AgentKind[]
) {
    const linked: AgentKind[] = []
    for (const kind of agents) {
        for (const dir of getAdapter(kind).skillDirs('~')) {
            const command = [
                `DIR=$(printf %s ${quoteShell(dir)} | sed "s|^~|$HOME|")`,
                `TARGET="$DIR/${validatePathSegment(skillName, 'skill name')}"`,
                `[ -L "$TARGET" ]`,
                `[ "$(readlink -f -- "$TARGET")" = ${quoteShell(skillPath)} ]`
            ].join(' && ')
            const result = await session.exec(command, { timeoutMs: 10000 })
            if (result.exitCode === 0) {
                linked.push(kind)
                break
            }
        }
    }
    return linked
}

function guessName(repoUrl: string) {
    const clean = repoUrl.replace(/\.git$/, '').replace(/\/$/, '')
    const part = clean.split('/').pop() || 'skill'
    return part.replace(/[^a-zA-Z0-9._-]/g, '-')
}

export function enabledAgentKinds(config: NexusConfig): AgentKind[] {
    return listAdapters()
        .map((a) => a.kind)
        .filter((kind) => config.agents[kind])
}
