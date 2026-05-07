const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const statusline = path.join(root, 'statusline.js');
const source = fs.readFileSync(statusline, 'utf8');

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function runStatusline(input, env = {}) {
  let stdout = '';
  const stdin = new EventEmitter();
  stdin.setEncoding = () => {};
  const context = {
    require: (name) => {
      if (name === 'child_process') return { execSync: () => '' };
      return require(name);
    },
    process: {
      env: { ...process.env, ...env },
      stdin,
      stdout: { write: (s) => { stdout += s; } },
      cwd: () => root,
      exit: (code) => { throw new Error(`unexpected exit ${code}`); }
    },
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    Date
  };
  vm.runInNewContext(source, context, { filename: statusline });
  stdin.emit('data', JSON.stringify(input));
  stdin.emit('end');
  return { raw: stdout, text: stripAnsi(stdout) };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-test-'));
}

function inputFor(dir, overrides = {}) {
  return {
    model: { display_name: 'Claude' },
    workspace: { current_dir: dir },
    session_id: 'test-session',
    ...overrides
  };
}

function remainingForDisplayedUsed(used) {
  const buffer = 16.5;
  return buffer + ((100 - used) * (100 - buffer)) / 100;
}

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    failures.push(`${name}\n${e.stack || e}`);
  }
}

check('model shortening', () => {
  const dir = makeTempDir();
  const cases = [
    ['Opus 4.7 (1M context)', 'Op4.7 (1m)'],
    ['Sonnet 4.6', 'So4.6'],
    ['Haiku 4.5', 'Ha4.5'],
    ['Claude', 'Claude'],
    ['claude-opus-4-7', 'Op4.7'],
    ['Opus 5.0 (200K context)  ', 'Op5.0 (200k)'],
    ['Æther 4.7', 'Æther 4.7'],
    ['', 'Claude']
  ];

  for (const [display_name, expected] of cases) {
    const { text } = runStatusline(inputFor(dir, { model: { display_name } }));
    assert.strictEqual(text.split(' │ ')[0], expected, display_name);
  }
});

check('context bar width and glyphs', () => {
  const dir = makeTempDir();
  for (let used = 0; used <= 100; used += 10) {
    const { text } = runStatusline(inputFor(dir, {
      context_window: { remaining_percentage: remainingForDisplayedUsed(used) }
    }));
    const segment = text.split(' │ ').find(p => p.endsWith(`${used}%`));
    assert(segment, `missing context segment for ${used}%: ${text}`);
    const bar = segment.includes('💀') ? segment.split(' ')[1] : segment.split(' ')[0];
    assert.strictEqual([...bar].length, 5, `bad width for ${used}%: ${bar}`);
    assert(/^[█▌░]{5}$/.test(bar), `bad glyphs for ${used}%: ${bar}`);
  }

  const over = runStatusline(inputFor(dir, {
    context_window: { remaining_percentage: 0 }
  })).text;
  assert(over.includes('100%'), over);
});

check('dirname middle ellipsis', () => {
  const parent = makeTempDir();
  const exact15 = path.join(parent, '123456789012345');
  const exact16 = path.join(parent, '1234567890123456');
  fs.mkdirSync(exact15);
  fs.mkdirSync(exact16);

  assert(runStatusline(inputFor(exact15)).text.includes('123456789012345'));
  assert(runStatusline(inputFor(exact16)).text.includes('1234567…0123456'));
  assert(runStatusline(inputFor(path.join(parent, '.claude'))).text.includes('.claude'));
});

check('cache TTL and JSONL parsing', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const session = 'cache-session';
  const slug = dir.replace(/[:\\\/]/g, '-');
  const projectDir = path.join(claude, 'projects', slug);
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, `${session}.jsonl`);
  const now = Date.now();

  fs.writeFileSync(transcript, [
    '{bad json',
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - 6 * 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10 } } } }),
    ''
  ].join('\n'));

  let out = runStatusline(inputFor(dir, { session_id: session }), { CLAUDE_CONFIG_DIR: claude }).text;
  assert(out.includes('cache ↓1.0k +10 5m:0m'), out);

  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', timestamp: 'not-a-date', message: { usage: { cache_read_input_tokens: 2000, cache_creation_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 20 } } } }),
    ''
  ].join('\n'));

  out = runStatusline(inputFor(dir, { session_id: session }), { CLAUDE_CONFIG_DIR: claude }).text;
  assert(out.includes('cache ↓2.0k +20 1h:0m'), out);
});

if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exitCode = 1;
}
