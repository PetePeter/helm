/** The memorising and recalling system skills, and the plan lifecycle cues that invoke them. */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { SkillManager } from '../src/session/skill-manager.js';
import { getToolReminder } from '../src/mcp/tools/reminders.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'helm-memory-skills-'));
  directories.push(directory);
  const skillManager = new SkillManager(join(directory, 'skills.yaml'));
  return new HelmControlService(
    {} as never, {} as never, {} as never, {} as never,
    undefined, undefined, undefined, undefined, skillManager,
  );
}

describe('memory system skills', () => {
  it('memorising resolves by type and teaches search-before-create and linking', () => {
    const skill = setup().resolveSkill('memorising');
    expect(skill?.id).toBe('sys-memorise');
    expect(skill?.body).toContain('memory_search');
    expect(skill?.body).toContain('memory_create');
    expect(skill?.body).toContain('memory_link');
  });

  it('recalling resolves by type and teaches searching memory', () => {
    const skill = setup().resolveSkill('recalling');
    expect(skill?.id).toBe('sys-recall');
    expect(skill?.body).toContain('memory_search');
    expect(skill?.body).toContain('memory_get');
  });

  it('claiming a plan cues recalling; completing one cues memorising', () => {
    expect(getToolReminder('session_plan_claim')).toContain('skill_get(type: "recalling")');
    expect(getToolReminder('plan_complete')).toContain('skill_get(type: "memorising")');
  });
});
