# Molecule Biology Eval Corpus v0

This corpus contains deterministic local tasks for the molecule-biology MCP.

Use:

```sh
npm run eval:corpus:v0:check
```

The checker verifies checked-in expected JSON and artifact hashes. It does not
regenerate expected files. Regeneration is manual only:

```sh
npm run eval:corpus:v0:generate
```
