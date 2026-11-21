---
name: skill-creator
description: Create or update a Cosmew skill with valid frontmatter and focused reusable instructions.
argument-hint: '[skill name and purpose]'
---

Create a focused skill for $ARGUMENTS. Ask only for information needed to define its behavior.

Use a directory containing SKILL.md under .cosmew/skills/<name> for project skills, or the user's ~/.cosmew/skills/<name> when requested and permitted. Existing .futryn/.hannes roots remain readable. Each file must be UTF-8 and at most 64 KiB. Begin with YAML frontmatter delimited by --- on separate lines. Required fields are name (1–64 ASCII letters, digits, underscores or hyphens, starting with a letter or digit) and description (nonempty string, at most 1024 characters). Quote strings containing YAML punctuation. Optional fields are disable-model-invocation (boolean) and argument-hint (string). The Markdown body contains instructions. The placeholder formed by `$` followed by `ARGUMENTS` is replaced by explicit slash-command arguments.

Describe when the skill should be selected. Keep the body focused on repeatable steps, inputs, checks and meaningful failure handling. Put optional resources and scripts beside SKILL.md and refer to their paths relative to the skill directory. Scripts run through exec_command with ordinary sandbox and approvals. A skill grants no tools or permissions; allowed-tools is ignored. Do not embed credentials or install dependencies without authorization.

Review the file size and frontmatter. Restart discovery in a new client and inspect /skills diagnostics. Test both /<name> arguments and $<name>. Use disable-model-invocation: true when only explicit invocation should expose the body.
