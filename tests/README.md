# Tests

Small smoke tests for the dependency-free statusline:

```bash
node tests/statusline-smoke.test.js
```

They execute `statusline.js` in a VM harness with `child_process` stubbed and use only Node.js built-ins.
