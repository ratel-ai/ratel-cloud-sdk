---
name: changelog
description: Update CHANGELOG.md for a @ratel-ai/cloud-sdk release. Drafts entries with git-cliff from conventional commits since the last tag, lets you curate, then writes the CHANGELOG. Handles both RC entries and GA-graduation collapse (merging X.Y.Z-rc.* sections into a single X.Y.Z section). Invoke before tagging a release.
---

# /changelog

Updates `CHANGELOG.md` in preparation for tagging a release. Adapted from the
[ratel-ai/ratel changelog skill](https://github.com/ratel-ai/ratel/blob/main/.claude/skills/changelog/SKILL.md)
for this single-package repo: one npm package (`@ratel-ai/cloud-sdk`), one root
`CHANGELOG.md`, plain `v*` tags.

`.github/workflows/release.yml` gates every release on the CHANGELOG: the
`tag-version-check` job rejects a tag whose version has no `## <version>` heading, or
whose heading still says "unreleased". This skill produces entries that pass that gate.

## Heading format (differs from the sister repo)

The CI gate greps `^## <version>\b` — **no square brackets**. Write headings as:

```
## X.Y.Z - YYYY-MM-DD
```

not the Keep-a-Changelog `## [X.Y.Z] - YYYY-MM-DD` style used in ratel-ai/ratel.
A bracketed heading fails the gate and blocks the release.

## Procedure

### 1. Read the version

```bash
node -p "require('./package.json').version"   # -> $TARGET
```

If the user supplies a different version explicitly, prefer that and warn them the
working tree disagrees. (The gate also enforces tag == package.json version, so a
mismatch will fail CI regardless.)

### 2. Determine the diff range

From the last release tag to `HEAD`:

```bash
FROM=$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)
```

If `$FROM` is empty nothing has shipped yet; the whole history is in range.

### 3. Generate the draft

```bash
bash .claude/skills/changelog/draft.sh
```

It emits Keep-a-Changelog sections (`### Added`, `### Fixed`, `### Changed`) or the
sentinel `_No user-facing changes._`. Pass an explicit `<from-ref>` argument to
override the automatic range.

If `draft.sh` exits 127, git-cliff is missing. Tell the user how to install it (the
script's stderr already does), and stop.

### 4. Branch on RC vs GA

Inspect `$TARGET` and edit `CHANGELOG.md`:

- **RC** (`X.Y.Z-rc.N`): prepend a new section above the most recent versioned section:
  ```
  ## X.Y.Z-rc.N - YYYY-MM-DD

  <draft content, or the sentinel>
  ```
  Use today's date in `YYYY-MM-DD` (UTC).

- **GA** (no `-rc` suffix): enter **GA-collapse mode**:
  1. Find every `## X.Y.Z-rc.*` section already present that matches the same
     `MAJOR.MINOR.PATCH` as `$TARGET`.
  2. Union their bullet entries (per subsection: `### Added`, `### Changed`, `### Fixed`)
     with the new draft entries from step 3 (commits since the last RC tag).
  3. Deduplicate bullets within each subsection (case-insensitive, whitespace-normalised).
  4. Drop the `_No user-facing changes._` sentinel if any real entries exist; keep it only
     if the unioned set is empty.
  5. Replace all the matched RC sections with a single `## X.Y.Z - YYYY-MM-DD` section
     containing the merged content.
  6. Leave non-matching prior versions untouched.

- **Placeholder heading**: if the CHANGELOG already has a `## $TARGET (unreleased)`
  placeholder (as the initial `0.1.0` entry did), replace `(unreleased)` with
  `- YYYY-MM-DD` and merge the draft content into that section instead of prepending
  a duplicate. The gate rejects headings containing "unreleased", so this replacement
  is mandatory before tagging.

### 5. Curate with the user

Show the pending CHANGELOG changes in the conversation. Ask the user to confirm or
edit. Common curation moves:

- Rephrase bullets for user-facing clarity (the draft uses commit subjects verbatim).
- Drop bullets that are not user-visible (internal refactors that slipped past
  `cliff.toml`'s skip rules).
- Merge duplicates that survived deduplication.
- Promote / demote between Added / Changed / Fixed if the commit prefix was wrong.

### 6. Write the file

Once approved, write `CHANGELOG.md` using the Edit tool. **Do not commit.** The release
commit is the user's responsibility — they typically include the CHANGELOG alongside
the version bump in a single `release: vX.Y.Z` commit.

### 7. Remind

Tell the user:

- The CHANGELOG is staged in the working tree (unstaged).
- Next step is the release commit + `v<version>` tag + push.
- The `release.yml` `tag-version-check` job verifies the tag matches `package.json`
  and that `CHANGELOG.md` contains a `## <version>` heading not marked unreleased;
  if either fails, the release is blocked.
- RC versions publish to the `rc` npm dist-tag automatically; GA versions to `latest`.

## Conventions

- **Heading format**: `## X.Y.Z - YYYY-MM-DD` — no brackets (CI gate requirement).
- **Date format**: `YYYY-MM-DD` in UTC.
- **Subsection order**: `### Added`, `### Changed`, `### Fixed`, `### Removed`,
  `### Deprecated`, `### Security`. Omit empty subsections.
- **Sentinel**: `_No user-facing changes._` when no in-scope commits exist.
