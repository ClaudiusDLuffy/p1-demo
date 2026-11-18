<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## App versioning

For every application update, increment the app version in `package.json` and
the matching root version fields in `package-lock.json` before handoff.
Use `major.minor.patch`:

- Patch (last number): small updates, bug fixes, and maintenance like these invoice fixes.
- Minor (middle number): larger features or moderately significant changes; reset patch to zero.
- Major (first number): major changes or breaking changes; reset minor and patch to zero.

Keep the portal's displayed version sourced from `package.json`. A version bump
does not authorize a commit, tag, deployment, or dependency change.
