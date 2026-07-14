import { describe, expect, it } from 'vitest'
import { matchDanger } from './danger'

const rules = [
  { pattern: 'rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*)(\\s|$)', enabled: 1 },
  { pattern: 'git\\s+push\\b.*(--force|-f)\\b', enabled: 1 },
  { pattern: '^\\s*sudo\\s+', enabled: 1 },
  { pattern: '\\bssh\\b.+\\b(rm|mv|tee|dd|systemctl|service|kill)\\b', enabled: 1 },
  { pattern: 'disabled-pattern', enabled: 0 }
]

describe('matchDanger (D7)', () => {
  it('hits recursive delete and force push', () => {
    expect(matchDanger(rules, 'Bash', { command: 'rm -rf /tmp/x' })).toBeTruthy()
    expect(matchDanger(rules, 'Bash', { command: 'git push origin main --force' })).toBeTruthy()
    expect(matchDanger(rules, 'Bash', { command: 'sudo systemctl restart nginx' })).toBeTruthy()
    expect(matchDanger(rules, 'Bash', { command: 'ssh prod "rm /srv/app.log"' })).toBeTruthy()
  })

  it('passes benign commands', () => {
    expect(matchDanger(rules, 'Bash', { command: 'git push origin main' })).toBeNull()
    expect(matchDanger(rules, 'Bash', { command: 'ls -la && rmdir empty' })).toBeNull()
    expect(matchDanger(rules, 'Bash', { command: 'grep -rf patterns.txt src' })).toBeNull()
  })

  it('only applies to Bash tool', () => {
    expect(matchDanger(rules, 'Write', { file_path: '/x', content: 'rm -rf /' })).toBeNull()
    expect(matchDanger(rules, 'Read', { file_path: '/x' })).toBeNull()
  })

  it('ignores disabled rules and invalid regex without throwing', () => {
    expect(matchDanger(rules, 'Bash', { command: 'disabled-pattern here' })).toBeNull()
    expect(matchDanger([{ pattern: '([bad', enabled: 1 }], 'Bash', { command: 'anything' })).toBeNull()
  })
})
