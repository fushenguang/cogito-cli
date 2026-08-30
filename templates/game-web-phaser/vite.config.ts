import { defineConfig } from 'vite'

// The dev/preview port is pinned to 8080 on purpose — do not change it.
//
// The outer platform (the VM host running the AI coding agent) builds
// share/preview links against a fixed, known port. If this drifts (e.g. Vite
// falling back to 5174 because 5173 was busy), the share link silently
// breaks with no error visible to the agent. `strictPort: true` makes any
// port conflict a loud startup failure instead of a silent port change.
//
// `host: true` binds to 0.0.0.0 so the dev server is reachable from outside
// the VM's loopback interface (required for the platform to proxy/share it).
export default defineConfig(({ mode }) => ({
  server: {
    port: 8080,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 8080,
    strictPort: true,
    host: true,
  },
  build: {
    // Two build targets, two output dirs — `build:play` (public share
    // link, no debug panel) and `build:learn` (debug panel, not public;
    // see package.json and src/debug/panel.ts). Separate outDirs mean the
    // two artifacts can never clobber each other and scripts/verify.mjs
    // always knows exactly which one it's serving.
    //
    // Which target wins is decided by `--mode` on the CLI, never by
    // anything read at runtime in the browser — see design D6 for why a
    // client-side switch was rejected (anyone can flip it, and the whole
    // point of build:play is a link a student can't see the debug panel
    // through).
    outDir: mode === 'learn' ? 'dist-learn' : 'dist-play',
  },
}))
