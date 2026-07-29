import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLaunchCommand, buildTmuxInnerCmd, buildTmuxEnvArgs, buildNewSessionArgs, newSessionAttempts } from '../src/launcher.js';

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

describe('buildTmuxEnvArgs', () => {
  // #58: Windows (Git Bash / MSYS2) environments carry names tmux -e rejects outright
  // ("invalid environment variable name"), killing session creation for EVERY variable
  // after the bad one is reached. Names must match POSIX [A-Za-z_][A-Za-z0-9_]* to pass.
  it('drops non-POSIX names that tmux -e rejects, keeps the rest (#58)', () => {
    const args = buildTmuxEnvArgs({
      'PATH': '/usr/bin',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      'CommonProgramFiles(x86)': 'C:\\Common',
      '=C:': 'C:\\Users\\me',
      '!ExitCode': '00000000',
      'ANTHROPIC_API_KEY': 'sk-ant-1',
    });
    assert.deepEqual(args, [
      '-e', 'PATH=/usr/bin',
      '-e', 'ANTHROPIC_API_KEY=sk-ant-1',
    ]);
  });

  // Exported bash functions (BASH_FUNC_name%%) are non-POSIX names that tmux 3.2/3.4
  // demonstrably ACCEPT and reconstruct inside the pane — HPC Environment Modules users
  // rely on them. The default (lenient) filter keeps them; the strict form (used as a
  // launch-failure fallback for tmux builds that reject exotic names, #58) drops them.
  it('keeps exported bash functions by default, drops them in strict mode', () => {
    const env = { PATH: '/usr/bin', 'BASH_FUNC_module%%': '() { eval $LMOD; }' };
    assert.deepEqual(buildTmuxEnvArgs(env), [
      '-e', 'PATH=/usr/bin',
      '-e', 'BASH_FUNC_module%%=() { eval $LMOD; }',
    ]);
    assert.deepEqual(buildTmuxEnvArgs(env, { strict: true }), ['-e', 'PATH=/usr/bin']);
  });

  it('still skips TMUX* and nullish values', () => {
    const args = buildTmuxEnvArgs({
      TMUX: '/tmp/tmux-1000/default,1,0',
      TMUX_PANE: '%5',
      HOME: '/home/me',
      EMPTY_OK: '',
      GONE: undefined,
    });
    assert.deepEqual(args, ['-e', 'HOME=/home/me', '-e', 'EMPTY_OK=']);
  });
});

describe('buildNewSessionArgs', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/me' };

  // `new-session -e` was added in tmux 3.2 (3.0 only added -e to new-window/split-window).
  // Ubuntu 20.04 ships 3.0a and Debian 11 ships 3.1c: gating at >= 3.0 made new-session
  // fail with "unknown option -- e" and the launch died outright on those distros.
  it('does NOT use -e below tmux 3.2 (3.0/3.1 lack new-session -e)', () => {
    for (const ver of [3.0, 3.1]) {
      const args = buildNewSessionArgs(ver, 's1', 'inner', env);
      assert.ok(!args.includes('-e'), `tmux ${ver} must not get -e`);
      assert.match(args[args.length - 1], /export PATH='\/usr\/bin'.*; inner$/);
    }
  });

  it('uses -e from tmux 3.2 onward', () => {
    const args = buildNewSessionArgs(3.2, 's1', 'inner', env);
    assert.deepEqual(args, ['new-session', '-d', '-s', 's1',
      '-e', 'PATH=/usr/bin', '-e', 'HOME=/home/me', 'inner']);
  });

  // tmux force-sets the pane's TERM from default-terminal; re-exporting the OUTER
  // terminal's TERM inside the pane (inline branch) defeats that and runs the TUI with
  // a non-tmux terminfo. The >=3.2 path already (correctly) lets tmux own TERM.
  it('the inline-export branch does not clobber the pane TERM', () => {
    const args = buildNewSessionArgs(3.1, 's1', 'inner', { PATH: '/usr/bin', TERM: 'xterm-256color' });
    assert.ok(!args[args.length - 1].includes('export TERM='), args[args.length - 1]);
  });
});

describe('newSessionAttempts', () => {
  it('adds a strict-filter fallback attempt only when the lenient env differs', () => {
    const envWithFn = { PATH: '/usr/bin', 'BASH_FUNC_module%%': '() { :; }' };
    const attempts = newSessionAttempts(3.2, 's1', 'inner', envWithFn);
    assert.equal(attempts.length, 2);
    assert.ok(attempts[0].includes('BASH_FUNC_module%%=() { :; }'));
    assert.ok(!attempts[1].some(a => a.startsWith('BASH_FUNC_')));
    // No exotic names → both filters agree → a single attempt.
    assert.equal(newSessionAttempts(3.2, 's1', 'inner', { PATH: '/usr/bin' }).length, 1);
    // Inline-export branch (< 3.2) never has a second form.
    assert.equal(newSessionAttempts(3.1, 's1', 'inner', envWithFn).length, 1);
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
