# Git Commit Helper Skill

Use this workflow whenever the user asks to commit changes, save progress, or create a git commit.

## Execution Steps

1. **Check Status & Branch:**
   - Run `git status` to see all staged, unstaged, and untracked changes.
   - Run `git branch --show-current` to identify the current feature branch.

2. **Inspect Changes:**
   - Run `git diff` to understand the exact scope of modified and newly created files.

3. **Format Conventional Commit Message:**
   - Choose appropriate type:
     - `feat`: New feature implementation
     - `fix`: Bug fix
     - `docs`: Documentation updates (e.g., `task.md`, `CLAUDE.md`)
     - `test`: Adding or updating tests
     - `refactor`: Refactoring code structure
     - `chore`: Updating build configs or dependencies
   - Derive scope from branch name or module folder (e.g., `auth`, `users`, `config`).
   - Write a clear, imperative sentence in English (under 72 chars).

4. **Execute Commit:**
   - Run `git add .`
   - Run `git commit -m "<type>(<scope>): <summary>"`
   - Output the status and created commit hash to the user.
