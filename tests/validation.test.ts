import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}))

import { existsSync, statSync } from 'node:fs'
import { validateProjectDirectory, validateProjectPath } from '../src/session/validation.js'

const mockExists = vi.mocked(existsSync)
const mockStat = vi.mocked(statSync)

describe('validateProjectDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not throw for a valid directory', () => {
    mockExists.mockReturnValue(true)
    mockStat.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>)
    expect(() => validateProjectDirectory('X:\\coding\\valid')).not.toThrow()
    expect(mockExists).toHaveBeenCalledWith('X:\\coding\\valid')
    expect(mockStat).toHaveBeenCalledWith('X:\\coding\\valid')
  })

  it('throws for empty string', () => {
    expect(() => validateProjectDirectory('')).toThrow('Directory path must not be empty')
    expect(mockExists).not.toHaveBeenCalled()
  })

  it('throws for whitespace-only string', () => {
    expect(() => validateProjectDirectory('   ')).toThrow('Directory path must not be empty')
  })

  it('throws for nonexistent directory', () => {
    mockExists.mockReturnValue(false)
    expect(() => validateProjectDirectory('X:\\coding\\nope')).toThrow('Directory does not exist')
    expect(mockStat).not.toHaveBeenCalled()
  })

  it('throws when path is a file not a directory', () => {
    mockExists.mockReturnValue(true)
    mockStat.mockReturnValue({ isDirectory: () => false } as ReturnType<typeof statSync>)
    expect(() => validateProjectDirectory('X:\\coding\\file.txt')).toThrow('Path is not a directory')
  })
})

describe('validateProjectPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts a non-empty path without checking whether it exists', () => {
    expect(() => validateProjectPath('X:\\coding\\removed')).not.toThrow()
    expect(mockExists).not.toHaveBeenCalled()
    expect(mockStat).not.toHaveBeenCalled()
  })

  it('rejects an empty path', () => {
    expect(() => validateProjectPath('  ')).toThrow('Directory path must not be empty')
  })
})
