import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectStore } from '../src/session/project-store.js';
import { HelmProjectService } from '../src/mcp/services/helm-project-service.js';

describe('HelmProjectService.createProject', () => {
  let tmpDir: string;
  let projectsFile: string;
  let realDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-project-svc-'));
    projectsFile = path.join(tmpDir, 'projects.json');
    realDir = path.join(tmpDir, 'a-real-project');
    fs.mkdirSync(realDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers a new project for an existing directory and persists it', () => {
    const store = new ProjectStore(projectsFile);
    const service = new HelmProjectService(store);

    const result = service.createProject(realDir);
    expect(result.canonicalPath).toBeTruthy();
    expect(result.id).toBeTruthy();

    // Persisted: a fresh store reloads the record.
    const reloaded = new ProjectStore(projectsFile);
    expect(reloaded.findByPath(realDir)?.id).toBe(result.id);
  });

  it('honours an explicit name', () => {
    const service = new HelmProjectService(new ProjectStore(projectsFile));
    const result = service.createProject(realDir, 'Custom Name');
    expect(result.name).toBe('Custom Name');
  });

  it('throws when the directory does not exist', () => {
    const service = new HelmProjectService(new ProjectStore(projectsFile));
    const missing = path.join(tmpDir, 'does-not-exist');
    expect(() => service.createProject(missing)).toThrow(/does not exist/i);
  });

  it('throws when the path is a file, not a directory', () => {
    const filePath = path.join(tmpDir, 'a-file.txt');
    fs.writeFileSync(filePath, 'hi');
    const service = new HelmProjectService(new ProjectStore(projectsFile));
    expect(() => service.createProject(filePath)).toThrow(/not a directory/i);
  });

  it('rejects a duplicate registration', () => {
    const service = new HelmProjectService(new ProjectStore(projectsFile));
    service.createProject(realDir);
    expect(() => service.createProject(realDir)).toThrow(/already registered/i);
  });
});

describe('HelmProjectService project rename/delete', () => {
  let tmpDir: string;
  let projectsFile: string;
  let realDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-project-svc-'));
    projectsFile = path.join(tmpDir, 'projects.json');
    realDir = path.join(tmpDir, 'a-real-project');
    fs.mkdirSync(realDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renames a project and persists the new name', () => {
    const service = new HelmProjectService(new ProjectStore(projectsFile));
    const created = service.createProject(realDir);
    service.renameProject(created.id, 'Renamed Project');

    const reloaded = new ProjectStore(projectsFile);
    expect(reloaded.getById(created.id)?.name).toBe('Renamed Project');
  });

  it('throws when renaming an unknown project', () => {
    const service = new HelmProjectService(new ProjectStore(projectsFile));
    expect(() => service.renameProject('nope', 'X')).toThrow(/not found/i);
  });

  it('deletes a project and persists the removal', () => {
    const store = new ProjectStore(projectsFile);
    const service = new HelmProjectService(store);
    const created = service.createProject(realDir);
    service.deleteProject(created.id);

    const reloaded = new ProjectStore(projectsFile);
    expect(reloaded.getById(created.id)).toBeUndefined();
  });

  it('throws when deleting an unknown project', () => {
    const service = new HelmProjectService(new ProjectStore(projectsFile));
    expect(() => service.deleteProject('nope')).toThrow(/not found/i);
  });

  it('keeps hidden projects in the MCP project list with their visibility flag', () => {
    const store = new ProjectStore(projectsFile);
    const visible = store.createProject(realDir, 'Visible');
    const hidden = store.createProject(path.join(tmpDir, 'hidden-project'), 'Hidden');
    store.setHiddenFromPicker(hidden.id, true);
    store.save();

    const projects = new HelmProjectService(new ProjectStore(projectsFile)).listProjects();
    expect(projects).toHaveLength(2);
    expect(projects.find(project => project.id === visible.id)).toMatchObject({ hiddenFromPicker: false });
    expect(projects.find(project => project.id === hidden.id)).toMatchObject({ hiddenFromPicker: true });
  });
});
