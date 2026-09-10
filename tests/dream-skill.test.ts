/** The dreaming system skill and its user-skill shadowing. */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { SkillManager } from '../src/session/skill-manager.js';
import { buildDreamGuide } from '../src/mcp/guides/dream-guide.js';
import { buildStartupGuide } from '../src/mcp/guides/startup-guide.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'helm-dream-skill-'));
  directories.push(directory);
  const skillManager = new SkillManager(join(directory, 'skills.yaml'));
  const service = new HelmControlService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    skillManager,
  );
  return { service, skillManager };
}

describe('dreaming system skill', () => {
  it('resolves by type and carries the pruning guidance', () => {
    const { service } = setup();

    const skill = service.resolveSkill('dreaming');

    expect(skill?.id).toBe('sys-dream');
    expect(skill?.source).toBe('system');
    expect(skill?.body).toContain('memory_dream');
    expect(skill?.body).toContain('memory_set_dormant');
    expect(service.getSkill('sys-dream')?.type).toBe('dreaming');
  });

  it('is shadowed by a user skill of the same type', () => {
    const { service, skillManager } = setup();
    const user = skillManager.create({
      name: 'House dreaming rules',
      description: 'Project dreaming policy',
      body: 'Prune nothing without asking.',
      type: 'dreaming',
      allProjects: true,
      projectIds: [],
    });

    const skill = service.resolveSkill('dreaming');

    expect(skill?.id).toBe(user.id);
    expect(skill?.source).toBe('user');
  });

  it('is advertised as discoverable in the startup guide', () => {
    expect(buildStartupGuide()).toContain('dreaming');
    expect(buildDreamGuide().length).toBeGreaterThan(0);
  });
});
