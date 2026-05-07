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

function runStatusline(input, env = {}, execFileSyncStub = () => '') {
  let stdout = '';
  const stdin = new EventEmitter();
  stdin.setEncoding = () => {};
  const context = {
    require: (name) => {
      if (name === 'child_process') return { execFileSync: execFileSyncStub };
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
    ['Opus 4.7 (1M context)', 'Op 4.7 (1m)'],
    ['Sonnet 4.6', 'So 4.6'],
    ['Haiku 4.5', 'Ha 4.5'],
    ['Claude', 'Claude'],
    ['claude-opus-4-7', 'Op 4.7'],
    ['Opus 5.0 (200K context)  ', 'Op 5.0 (200k)'],
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

check('dirname middle ellipsis triggers only when line >100 cols', () => {
  const parent = makeTempDir();
  const exact15 = path.join(parent, '123456789012345');
  const exact16 = path.join(parent, '1234567890123456');
  const huge = path.join(parent, '0123456789'.repeat(12)); // 120 chars, alone breaks 100
  fs.mkdirSync(exact15);
  fs.mkdirSync(exact16);
  fs.mkdirSync(huge);

  // Short line → no truncation regardless of dirname length.
  const t15 = runStatusline(inputFor(exact15)).text;
  assert(t15.includes('123456789012345'), `len-15: full kept, got ${t15}`);
  assert(!t15.includes('…'), `len-15: no ellipsis expected, got ${t15}`);

  const t16 = runStatusline(inputFor(exact16)).text;
  assert(t16.includes('1234567890123456'), `len-16 short line: full kept, got ${t16}`);
  assert(!t16.includes('…'), `len-16 short line: no ellipsis, got ${t16}`);

  // Dotfile-style name should pass through.
  assert(runStatusline(inputFor(path.join(parent, '.claude'))).text.includes('.claude'));

  // Long line → middle ellipsis kicks in.
  const big = runStatusline(inputFor(huge)).text;
  assert(big.includes('0123456…3456789'), `huge dirname: ellipsis expected, got ${big}`);
  assert(!big.includes('0123456789012345'), `huge dirname: full must NOT appear, got ${big}`);
});

check('git segment shows dirty count, branch, and ahead push', () => {
  const dir = makeTempDir();
  const git = (file, args) => {
    assert.strictEqual(file, 'git');
    const key = args.join(' ');
    const responses = {
      'status --porcelain': ' M foo.js\n?? bar.js',
      'branch --show-current': 'main',
      'rev-list --count HEAD..refs/remotes/origin/main': '0',
      'rev-list --count refs/remotes/origin/main..HEAD': '2'
    };
    return responses[key] || '';
  };

  const { text } = runStatusline(inputFor(dir), {}, git);
  assert(text.includes(`${path.basename(dir)} (main)`), text);
  assert(text.includes('2 dirty'), text);
  assert(text.includes('↑2 push'), text);
  assert(!text.includes('pull'), text);
});

check('git segment shows detached HEAD short sha', () => {
  const dir = makeTempDir();
  const git = (file, args) => {
    assert.strictEqual(file, 'git');
    const key = args.join(' ');
    const responses = {
      'status --porcelain': '',
      'branch --show-current': '',
      'rev-parse --short HEAD': 'deadbee'
    };
    return responses[key] || '';
  };

  const { text } = runStatusline(inputFor(dir), {}, git);
  assert(text.includes(`${path.basename(dir)} (HEAD@deadbee)`), text);
});

check('rate limits show 5h and 7d countdowns with coarse 7d', () => {
  const dir = makeTempDir();
  const now = Math.floor(Date.now() / 1000);

  // 5h shows precise h+m; 7d ≥2d is coarse (days only).
  const t1 = runStatusline(inputFor(dir, {
    rate_limits: {
      five_hour: { used_percentage: 35, resets_at: now + 8100 },     // 2h15m
      seven_day: { used_percentage: 42, resets_at: now + 388800 }    // 4d12h → "4d"
    }
  })).text;
  assert(t1.includes('5h:35%(2h15m)'), t1);
  assert(t1.includes('7d:42%(4d)'), t1);
  assert(!t1.includes('4d12h'), `7d must drop hours when ≥2d, got: ${t1}`);

  // 7d with <2d remaining keeps hours.
  const t2 = runStatusline(inputFor(dir, {
    rate_limits: {
      seven_day: { used_percentage: 88, resets_at: now + 169200 }    // 1d23h → "1d23h"
    }
  })).text;
  assert(t2.includes('7d:88%(1d23h)'), t2);

  // Exactly 2d → still coarse.
  const t3 = runStatusline(inputFor(dir, {
    rate_limits: {
      seven_day: { used_percentage: 50, resets_at: now + 172800 }    // 2d → "2d"
    }
  })).text;
  assert(t3.includes('7d:50%(2d)'), t3);

  // Exactly 1d → "24h", never bare "1d".
  const t4 = runStatusline(inputFor(dir, {
    rate_limits: {
      seven_day: { used_percentage: 90, resets_at: now + 86400 }     // 1d → "24h"
    }
  })).text;
  assert(t4.includes('7d:90%(24h)'), t4);
  assert(!/\(1d\)/.test(t4), `must not render bare "1d", got: ${t4}`);

  // No reset_at → no countdown; 7d still shows pct.
  const minimal = runStatusline(inputFor(dir, {
    rate_limits: { seven_day: { used_percentage: 99 } }
  })).text;
  assert(/7d:99%(?!\()/.test(minimal), minimal);
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
