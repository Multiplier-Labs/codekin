# Contributing to Codekin

Thank you for your interest in contributing to Codekin! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 20+
- npm
- Claude Code CLI (`claude`) installed and configured

### Getting Started

```bash
# Clone the repository
git clone https://github.com/Multiplier-Labs/codekin.git
cd codekin

# Install frontend dependencies
npm install

# Install server dependencies
npm install --prefix server

# Start the development server (frontend only)
npm run dev
```

### Environment Variables

For full functionality, set these environment variables:

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `GROQ_API_KEY` | No | Session auto-naming via Groq |
| `GEMINI_API_KEY` | No | `/validate-gemini` skill |
| `OPENAI_API_KEY` | No | `/validate-gpt` skill |

### Running Tests

```bash
npm test            # run tests once
npm run test:watch  # watch mode
```

### Linting

```bash
npm run lint
```

### Building

```bash
npm run build
```

## Coding Conventions

- **TypeScript strict mode** for server code
- **TailwindCSS utility classes** for styling (custom theme in `src/index.css`)
- **Monospace font**: Inconsolata; **Sans font**: Lato
- WebSocket message types are defined in `src/types.ts`

## Branching & Release Policy

- **`main`** — stable, always releasable. No direct pushes once public.
- **Feature branches** — use `feat/description` naming, merged via PR.
- **Bug fix branches** — use `fix/description` naming.
- **Release tags** — follow [semver](https://semver.org/): `v0.2.0`, `v1.0.0`, etc.
- **Branch protection** — PRs require review and passing CI before merge.

## Pull Request Process

1. Fork the repository and create your branch from `main`.
2. Make your changes, ensuring tests pass (`npm test`) and lint is clean (`npm run lint`).
3. Write clear, descriptive commit messages.
4. Open a pull request with a summary of what you changed and why.
5. Ensure CI checks pass on your PR.

### PR Guidelines

- Keep PRs focused — one feature or fix per PR.
- Add tests for new functionality when applicable.
- Update documentation if your change affects the public API or setup process.
- Don't include unrelated formatting or refactoring changes.

## Reporting Bugs

Use the [bug report template](https://github.com/Multiplier-Labs/codekin/issues/new?template=bug_report.md) to file issues. Include:

- Steps to reproduce
- Expected vs actual behavior
- Browser and OS information
- Screenshots if applicable

## Requesting Features

Use the [feature request template](https://github.com/Multiplier-Labs/codekin/issues/new?template=feature_request.md) to suggest ideas.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
