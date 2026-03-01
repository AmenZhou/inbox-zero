// Stub out Next.js-specific modules so standalone scripts can run outside the
// Next.js runtime. Preload with: npx tsx -r ./scripts/stub-server-only.cjs

// Make React available globally so that workspace packages using the classic
// JSX transform (React.createElement) can compile without a Next.js runtime.
global.React = require("react");

const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  if (request === "server-only") return __filename;
  return origResolve.call(this, request, parent, ...args);
};

// Stub next/server's `after()` — it schedules background work that requires
// the Next.js request scope. In standalone scripts, just run the callback
// synchronously (fire-and-forget).
const nextServerPath = require.resolve("next/dist/server/after/after.js");
require(nextServerPath);
require.cache[nextServerPath].exports = {
  after: function after(cb) {
    if (typeof cb === "function") {
      Promise.resolve().then(cb).catch(() => {});
    }
  },
};
