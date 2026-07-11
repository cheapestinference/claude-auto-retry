import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLaunchCommand, buildTmuxInnerCmd } from '../src/launcher.js';

describe('resolveLaunchCommand', () => {
  it('spawns claude directly when no wrapper is set', () => {
    assert.deepEqual(
      resolveLaunchCommand('/usr/bin/claude', ['--resume'], {}),
      { cmd: '/usr/bin/claude', cmdArgs: ['--resume'] },
    );
  });

  it('treats an empty/whitespace wrapper as unset', () => {
    assert.deepEqual(
      resolveLaunchCommand('claude', ['-c'], { CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER: '   ' }),
      { cmd: 'claude', cmdArgs: ['-c'] },
    );
  });

  it('prepends a wrapper command (e.g. caffeinate -i) before claude and its args', () => {
    assert.deepEqual(
      resolveLaunchCommand('/usr/bin/claude', ['--resume'], { CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER: 'caffeinate -i' }),
      { cmd: 'caffeinate', cmdArgs: ['-i', '/usr/bin/claude', '--resume'] },
    );
  });

  it('handles a bare single-token wrapper and extra whitespace', () => {
    assert.deepEqual(
      resolveLaunchCommand('claude', [], { CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER: '  nice   ' }),
      { cmd: 'nice', cmdArgs: ['claude'] },
    );
  });
});

describe('buildTmuxInnerCmd', () => {
  it('execs the user\'s $SHELL after the launcher exits, not a hardcoded bash', () => {
    const cmd = buildTmuxInnerCmd('/path/launcher.js', [], { SHELL: '/bin/zsh' });
    assert.match(cmd, /exec '\/bin\/zsh'$/);
  });

  it('falls back to bash when $SHELL is unset', () => {
    const cmd = buildTmuxInnerCmd('/path/launcher.js', [], {});
    assert.match(cmd, /exec 'bash'$/);
  });

  it('still runs the launcher with escaped path and args before the exec', () => {
    const cmd = buildTmuxInnerCmd('/path/launcher.js', ['--resume'], { SHELL: '/bin/zsh' });
    assert.equal(
      cmd,
      "CLAUDE_AUTO_RETRY_ACTIVE=1 node '/path/launcher.js' '--resume'; exec '/bin/zsh'",
    );
  });
});
