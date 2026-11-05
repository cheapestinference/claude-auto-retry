const {
  EXCLUDED_ENV_VARS,
  filterEnv,
  createEnvSnapshot,
  applyEnvSnapshot,
} = require('../src/launcher');

describe('Launcher Environment Snapshotting', () => {
  const sampleEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.4.0',
    CUSTOM_VAR: 'hello',
  };

  test('EXCLUDED_ENV_VARS contains TERM, TERM_PROGRAM, and TERM_PROGRAM_VERSION', () => {
    expect(EXCLUDED_ENV_VARS).toContain('TERM');
    expect(EXCLUDED_ENV_VARS).toContain('TERM_PROGRAM');
    expect(EXCLUDED_ENV_VARS).toContain('TERM_PROGRAM_VERSION');
  });

  test('filterEnv removes terminal-related variables', () => {
    const filtered = filterEnv(sampleEnv);
    expect(filtered).toHaveProperty('PATH', '/usr/bin:/bin');
    expect(filtered).toHaveProperty('HOME', '/home/user');
    expect(filtered).toHaveProperty('CUSTOM_VAR', 'hello');
    expect(filtered).not.toHaveProperty('TERM');
    expect(filtered).not.toHaveProperty('TERM_PROGRAM');
    expect(filtered).not.toHaveProperty('TERM_PROGRAM_VERSION');
  });

  test('createEnvSnapshot filters terminal variables', () => {
    const snapshot = createEnvSnapshot(sampleEnv);
    expect(snapshot).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      CUSTOM_VAR: 'hello',
    });
  });

  test('applyEnvSnapshot applies non-terminal variables and ignores terminal variables', () => {
    const target = {
      TERM: 'screen-256color',
    };
    const snapshotWithTerm = {
      ...sampleEnv,
      TERM: 'xterm-256color',
    };

    applyEnvSnapshot(snapshotWithTerm, target);

    expect(target.PATH).toBe('/usr/bin:/bin');
    expect(target.CUSTOM_VAR).toBe('hello');
    expect(target.TERM).toBe('screen-256color');
    expect(target.TERM_PROGRAM).toBeUndefined();
    expect(target.TERM_PROGRAM_VERSION).toBeUndefined();
  });
});
